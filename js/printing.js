/**
 * Thin wrapper around the vendored phomymo BLE transport + protocol layer.
 */

import { BLETransport } from './vendor/phomymo/ble.js';
import {
  loadPrinterDefinitions,
  print,
  getPrinterWidthBytes,
  getPrinterDescription,
} from './vendor/phomymo/printer.js';
import { canvasToRaster } from './dither.js';

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

/** Printer width in dots — from the connected device, or the M250 default. */
export async function printerWidthDots() {
  await ensureDefinitions();
  const transport = BLETransport.getShared();
  if (transport.isConnected()) {
    return getPrinterWidthBytes(transport.getDeviceName()) * 8;
  }
  return DEFAULT_WIDTH_BYTES * 8;
}

/**
 * Dither a composed receipt canvas and send it to the connected printer.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} settings - {density, feed, contrast}
 * @param {Function} onProgress - percent callback
 */
export async function printCanvas(canvas, settings, onProgress = null) {
  await ensureDefinitions();
  const transport = BLETransport.getShared();
  if (!transport.isConnected()) throw new Error('Printer not connected');
  const raster = canvasToRaster(canvas, { contrast: settings.contrast });
  await print(transport, raster, {
    isBLE: true,
    deviceName: transport.getDeviceName(),
    density: settings.density,
    feed: settings.feed,
    onProgress,
  });
}
