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
} from './vendor/phomymo/printer.js';
import { canvasToRaster } from './dither.js';

const DOTS_PER_MM = 8; // 203 dpi

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
 * printer definitions).
 */
function padToHead(canvas, headDots, deviceName) {
  if (canvas.width >= headDots) return canvas;
  const padded = document.createElement('canvas');
  padded.width = headDots;
  padded.height = canvas.height;
  const ctx = padded.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, padded.width, padded.height);
  const alignment = getPrinterAlignment(deviceName);
  const x = alignment === 'right' ? headDots - canvas.width
    : alignment === 'left' ? 0
    : Math.round((headDots - canvas.width) / 2);
  ctx.drawImage(canvas, x, 0);
  return padded;
}

// Media-type command shared across Phomemo firmwares:
// 1F 11 0B = continuous (no gap detection), 1F 11 0A = die-cut labels.
const MEDIA_CONTINUOUS = new Uint8Array([0x1f, 0x11, 0x0b]);
const MEDIA_GAPS = new Uint8Array([0x1f, 0x11, 0x0a]);

/**
 * Dither a composed receipt canvas and send it to the connected printer.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} settings - {density, feed, contrast, paperWidthMm, continuous}
 * @param {Function} onProgress - percent callback
 */
export async function printCanvas(canvas, settings, onProgress = null) {
  await ensureDefinitions();
  const transport = BLETransport.getShared();
  if (!transport.isConnected()) throw new Error('Printer not connected');
  const deviceName = transport.getDeviceName();

  await transport.send(settings.continuous !== false ? MEDIA_CONTINUOUS : MEDIA_GAPS);
  await transport.delay(30);

  const head = getPrinterWidthBytes(deviceName) * 8;
  const raster = canvasToRaster(padToHead(canvas, head, deviceName), { contrast: settings.contrast });
  await print(transport, raster, {
    isBLE: true,
    deviceName,
    density: settings.density,
    feed: settings.feed,
    onProgress,
  });
}
