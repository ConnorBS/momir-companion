/**
 * 1-bit conversion for thermal printing.
 *
 * Pipeline: luminance grayscale -> percentile contrast stretch -> gamma
 * (brightness, compensates thermal dot gain) -> contrast -> unsharp mask ->
 * dither -> packed raster bytes (1 = black dot, MSB-first), the format the
 * Phomemo ESC/POS raster command expects.
 *
 * Dither styles:
 *  - atkinson (default): diffuses only 3/4 of the error — prints lighter
 *    with crisp highlights, which suits thermal paper where dots bleed.
 *  - fs: Floyd–Steinberg, denser and smoother but muddier on thermal.
 *  - bayer: 4x4 ordered dither, a regular pattern that never "worms".
 *  - threshold: hard 50% cut, for text-only output.
 */

const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Convert a canvas to packed 1-bit raster data.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} opts
 * @param {number} opts.contrast - contrast multiplier around mid-gray (1 = none)
 * @param {number} opts.brightness - gamma lift; >1 brightens midtones (1 = none)
 * @param {string} opts.dither - 'atkinson' | 'fs' | 'bayer' | 'threshold'
 * @param {number} opts.sharpen - unsharp-mask amount (0 = off)
 * @param {number} opts.clipPercent - percentile clip for auto-levels (0-10)
 * @returns {{data: Uint8Array, widthBytes: number, heightLines: number}}
 */
export function canvasToRaster(canvas, {
  contrast = 1.25,
  brightness = 1.15,
  dither = 'atkinson',
  sharpen = 0.3,
  clipPercent = 2,
} = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const { data: rgba } = ctx.getImageData(0, 0, w, h);

  // Grayscale (Rec. 601 luminance), white background under any transparency
  let gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const r = rgba[i * 4] * a + 255 * (1 - a);
    const g = rgba[i * 4 + 1] * a + 255 * (1 - a);
    const b = rgba[i * 4 + 2] * a + 255 * (1 - a);
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // Auto-levels: stretch between the clipPercent / (100-clipPercent) percentiles
  if (clipPercent > 0) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[Math.round(gray[i])]++;
    const clipCount = (clipPercent / 100) * gray.length;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= clipCount) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= clipCount) { hi = v; break; } }
    if (hi > lo) {
      const scale = 255 / (hi - lo);
      for (let i = 0; i < gray.length; i++) {
        gray[i] = Math.max(0, Math.min(255, (gray[i] - lo) * scale));
      }
    }
  }

  // Gamma lift: thermal dots print fatter than nominal (dot gain), so
  // brighten midtones ahead of time to keep the art from going muddy
  if (brightness !== 1) {
    const inv = 1 / brightness;
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 255 * Math.pow(gray[i] / 255, inv);
    }
  }

  // Contrast around mid-gray
  if (contrast !== 1) {
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, (gray[i] - 128) * contrast + 128));
    }
  }

  // Unsharp mask (3x3 box blur as the low-pass) to recover edge detail
  if (sharpen > 0 && dither !== 'threshold') {
    const blurred = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < h && xx >= 0 && xx < w) { sum += gray[yy * w + xx]; count++; }
          }
        }
        blurred[y * w + x] = sum / count;
      }
    }
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, gray[i] + (gray[i] - blurred[i]) * sharpen));
    }
  }

  // Dither to 1-bit
  if (dither === 'fs') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = gray[i];
        const val = old < 128 ? 0 : 255;
        gray[i] = val;
        const err = old - val;
        if (x + 1 < w) gray[i + 1] += err * 7 / 16;
        if (y + 1 < h) {
          if (x > 0) gray[i + w - 1] += err * 3 / 16;
          gray[i + w] += err * 5 / 16;
          if (x + 1 < w) gray[i + w + 1] += err * 1 / 16;
        }
      }
    }
  } else if (dither === 'atkinson') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = gray[i];
        const val = old < 128 ? 0 : 255;
        gray[i] = val;
        const err = (old - val) / 8; // only 6/8 diffused — the rest is dropped
        if (x + 1 < w) gray[i + 1] += err;
        if (x + 2 < w) gray[i + 2] += err;
        if (y + 1 < h) {
          if (x > 0) gray[i + w - 1] += err;
          gray[i + w] += err;
          if (x + 1 < w) gray[i + w + 1] += err;
        }
        if (y + 2 < h) gray[i + 2 * w] += err;
      }
    }
  } else if (dither === 'bayer') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const threshold = (BAYER_4[y & 3][x & 3] + 0.5) * 16;
        gray[i] = gray[i] < threshold ? 0 : 255;
      }
    }
  } else { // threshold
    for (let i = 0; i < gray.length; i++) gray[i] = gray[i] < 128 ? 0 : 255;
  }

  // Pack bits: 1 = black, MSB first
  const widthBytes = Math.ceil(w / 8);
  const data = new Uint8Array(widthBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < 128) {
        data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return { data, widthBytes, heightLines: h };
}

/** Raster options derived from user settings (shared by preview and print). */
export function rasterOpts(settings) {
  return {
    contrast: settings.contrast,
    brightness: settings.brightness ?? 1.15,
    dither: settings.dither || 'atkinson',
  };
}

/** Render raster data back onto a canvas (print preview of the exact dots). */
export function rasterToCanvas(raster) {
  const { data, widthBytes, heightLines } = raster;
  const w = widthBytes * 8;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = heightLines;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, heightLines);
  for (let y = 0; y < heightLines; y++) {
    for (let x = 0; x < w; x++) {
      const black = (data[y * widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const v = black ? 0 : 255;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
