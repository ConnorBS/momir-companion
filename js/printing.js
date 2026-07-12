/**
 * Thin wrapper around the vendored phomymo BLE transport + protocol layer.
 */

import { BLETransport } from './vendor/phomymo/ble.js';
import {
  loadPrinterDefinitions,
  print,
  getPrinterWidthBytes,
  getPrinterAlignment,
  getPrinterDescription,
  getDetectedDefinition,
} from './vendor/phomymo/printer.js';
import { canvasToRaster, rasterOpts } from './dither.js';

const DOTS_PER_MM = 8; // 203 dpi
// Rough physical print speed used to hold the queue until a job clears the
// head; sending the next job's init early truncates the one still printing.
// Dense art rows print slowly (the head needs heat time), so err generous.
const MS_PER_ROW = 12;

const DEFAULT_WIDTH_BYTES = 72; // M250: 72 bytes = 576 dots @ 203dpi

let definitionsLoaded = false;

async function ensureDefinitions() {
  if (!definitionsLoaded) {
    await loadPrinterDefinitions('./js/vendor/phomymo/printers.json');
    definitionsLoaded = true;
  }
}

export function isBluetoothAvailable() {
  return BLETransport.isAvailable();
}

export async function connectPrinter() {
  await ensureDefinitions();
  const transport = BLETransport.getShared();
  await transport.connect();
  try { await transport.queryAll(); } catch { /* status queries are best-effort */ }
  startKeepalive();
  return {
    name: transport.getDeviceName(),
    description: getPrinterDescription(transport.getDeviceName()),
  };
}

export async function disconnectPrinter() {
  await BLETransport.getShared().disconnect();
}

export function isPrinterConnected() {
  return BLETransport.getShared().isConnected();
}

export function printerName() {
  return BLETransport.getShared().getDeviceName();
}

export function printerInfo() {
  return BLETransport.getShared().getPrinterInfo();
}

export function onPrinterDisconnect(callback) {
  BLETransport.getShared().onDisconnect = callback;
}

/** Full print-head width in dots — from the connected device, or the M250 default. */
export async function headWidthDots() {
  await ensureDefinitions();
  const transport = BLETransport.getShared();
  if (transport.isConnected()) {
    return getPrinterWidthBytes(transport.getDeviceName()) * 8;
  }
  return DEFAULT_WIDTH_BYTES * 8;
}

/**
 * Width the receipt content should render at: the configured paper width,
 * capped at the head. Narrower rolls (e.g. 57mm receipt paper in a 72mm
 * M250) render smaller and get centered on the head at print time.
 */
export async function printerWidthDots(settings = null) {
  const head = await headWidthDots();
  const paper = Math.round((settings?.paperWidthMm || 0) * DOTS_PER_MM);
  return paper > 0 ? Math.min(head, paper) : head;
}

/**
 * Position content on the full head for the loaded roll: centered for
 * center-fed printers, flush right for right-aligned ones (per phomymo's
 * printer definitions), plus the user's calibration offset in mm
 * (positive shifts toward the right edge of the print).
 */
function padToHead(canvas, headDots, deviceName, offsetMm = 0) {
  const offset = Math.round(offsetMm * DOTS_PER_MM);
  if (canvas.width >= headDots && !offset) return canvas;
  const padded = document.createElement('canvas');
  padded.width = Math.max(headDots, canvas.width);
  padded.height = canvas.height;
  const ctx = padded.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, padded.width, padded.height);
  const alignment = getPrinterAlignment(deviceName);
  const base = alignment === 'right' ? padded.width - canvas.width
    : alignment === 'left' ? 0
    : Math.round((padded.width - canvas.width) / 2);
  ctx.drawImage(canvas, Math.max(0, Math.min(padded.width - canvas.width, base + offset)), 0);
  return padded;
}

/**
 * Faster BLE transfer: the vendored protocol pauses 20ms between 128-byte
 * chunks, which is conservative. This wrapper halves only those short
 * chunk delays, leaving init/heat timing untouched.
 */
function fastTransport(transport) {
  return {
    send: (data) => transport.send(data),
    delay: (ms) => transport.delay(ms <= 20 ? 6 : ms),
    waitForResponse: transport.waitForResponse?.bind(transport),
  };
}

// Phomemo printers auto-sleep and Android drops idle BLE links, which is why
// the connection kept needing manual reconnects. A periodic battery query
// keeps both ends awake — but never during a print, where injected query
// bytes would corrupt the raster stream.
let keepaliveTimer = null;
let printing = false;

function startKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(async () => {
    const transport = BLETransport.getShared();
    if (printing || !transport.isConnected()) return;
    try { await transport.query('battery'); } catch { /* best-effort */ }
  }, 45000);
}

// Abortable generic m-series sender (the M250 path). Mirrors the vendored
// printBLE() commands, but checks an AbortSignal between chunks: on abort it
// completes the declared raster with blank rows so the printer finishes
// cleanly instead of stalling on a half-delivered image.
const MS = {
  INIT: new Uint8Array([0x1b, 0x40]),
  HEAT: (time) => new Uint8Array([0x1b, 0x37, 7, time, 2]),
  DENSITY: (level) => new Uint8Array([0x1d, 0x7c, level]),
  HEADER: (widthBytes, heightLines) => new Uint8Array([
    0x1d, 0x76, 0x30, 0x00, widthBytes, 0x00, heightLines & 0xff, (heightLines >> 8) & 0xff,
  ]),
  FEED: (dots) => new Uint8Array([0x1b, 0x4a, dots]),
};
const HEAT_TIMES = [40, 60, 80, 100, 120, 140, 160, 200];

// Phomemo firmware silently discards a raster command that declares too many
// rows (a 7-card batch in one command prints nothing at all), so tall images
// are sent as consecutive ≤255-row blocks — the approach the reference
// phomemo-tools driver uses. Blocks butt together with no visible seam.
const BLOCK_ROWS = 255;

async function printMSeriesAbortable(transport, raster, { density, feed, onProgress, signal }) {
  const { data, widthBytes, heightLines } = raster;
  await transport.send(MS.INIT);
  await transport.delay(100);
  await transport.send(MS.HEAT(HEAT_TIMES[Math.max(0, Math.min(7, density - 1))]));
  await transport.delay(30);
  await transport.send(MS.DENSITY(density));
  await transport.delay(50);

  const chunkSize = 128;
  const blank = new Uint8Array(chunkSize);
  let cancelled = false;
  for (let row = 0; row < heightLines; row += BLOCK_ROWS) {
    if (cancelled) break; // cancelled mid-block: skip the remaining blocks entirely
    const rows = Math.min(BLOCK_ROWS, heightLines - row);
    await transport.send(MS.HEADER(widthBytes, rows));
    const start = row * widthBytes;
    const end = start + rows * widthBytes;
    for (let i = start; i < end; i += chunkSize) {
      const size = Math.min(chunkSize, end - i);
      if (!cancelled && signal?.aborted) cancelled = true;
      // A started block must be completed (with blanks if cancelled) so the
      // printer isn't left waiting on a half-delivered raster.
      await transport.send(cancelled ? blank.subarray(0, size) : data.slice(i, i + size));
      await transport.delay(cancelled ? 8 : 20);
      if (!cancelled && onProgress) onProgress(Math.round((i + size) / data.length * 100));
    }
  }

  await transport.delay(300);
  await transport.send(MS.FEED(feed));
  await transport.delay(500);
  return cancelled ? 'cancelled' : 'done';
}

/** GATT-only reconnect to the already-paired device — never opens the picker. */
async function tryReconnect(transport) {
  if (transport.isConnected()) return true;
  if (!transport.device) return false;
  try {
    await transport.retryWithBackoff(() => transport.connectGATT(), 2, 300);
    return true;
  } catch {
    return false;
  }
}

// Media-type command shared across Phomemo firmwares:
// 1F 11 0B = continuous (no gap detection), 1F 11 0A = die-cut labels.
const MEDIA_CONTINUOUS = new Uint8Array([0x1f, 0x11, 0x0b]);
const MEDIA_GAPS = new Uint8Array([0x1f, 0x11, 0x0a]);

// Jobs are chained so a second print can never start while the printer is
// still working through the first one's buffer (its ESC @ init would
// truncate the print mid-card).
let printQueue = Promise.resolve();

/**
 * Dither a composed receipt canvas and send it to the connected printer.
 * Queued: concurrent calls run strictly one after another.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} settings - {density, feed, contrast, brightness, dither,
 *                             paperWidthMm, continuous, offsetMm, fastTransfer}
 * @param {Function} onProgress - percent callback
 */
export function printCanvas(canvas, settings, onProgress = null, signal = null) {
  const job = printQueue.then(() => doPrint(canvas, settings, onProgress, signal));
  printQueue = job.catch(() => { /* a failed job must not block the queue */ });
  return job;
}

async function doPrint(canvas, settings, onProgress, signal) {
  if (signal?.aborted) return 'cancelled'; // aborted while waiting in the queue
  await ensureDefinitions();
  const base = BLETransport.getShared();
  if (!base.isConnected() && !(await tryReconnect(base))) {
    throw new Error('Printer not connected');
  }
  const deviceName = base.getDeviceName();
  const transport = settings.fastTransfer ? fastTransport(base) : base;

  printing = true;
  try {
    await transport.send(settings.continuous !== false ? MEDIA_CONTINUOUS : MEDIA_GAPS);
    await transport.delay(30);

    const head = getPrinterWidthBytes(deviceName) * 8;
    const padded = padToHead(canvas, head, deviceName, settings.offsetMm || 0);
    const raster = canvasToRaster(padded, rasterOpts(settings));

    // Generic m-series (the M250 path) goes through our abortable sender;
    // specialty protocols fall back to the vendored one (abort only pre-start).
    const protocol = getDetectedDefinition(deviceName)?.protocol ?? 'm-series';
    let result = 'done';
    if (protocol === 'm-series') {
      result = await printMSeriesAbortable(transport, raster, {
        density: settings.density,
        feed: settings.feed,
        onProgress,
        signal,
      });
    } else {
      await print(transport, raster, {
        isBLE: true,
        deviceName,
        density: settings.density,
        feed: settings.feed,
        onProgress,
      });
    }

    // Data is sent, but the head is still printing from its buffer — hold the
    // queue for the estimated physical print time before the next job.
    await base.delay(result === 'cancelled' ? 1500 : Math.min(15000, raster.heightLines * MS_PER_ROW));
    return result;
  } finally {
    printing = false;
  }
}
