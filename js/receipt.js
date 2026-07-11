/**
 * Receipt renderer: composes a card onto a canvas at printer width.
 *
 * Layout (top to bottom): name + mana cost, art crop (high-contrast B&W),
 * type line, oracle text, P/T, set/artist footer. Text is drawn pure black
 * on white so it survives dithering crisply; only the art actually dithers.
 */

const PAD = 8;

function loadImage(url, retry = true) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    // Scryfall's CDN serves `vary: Origin` with long max-age; a cached
    // non-CORS copy of the same URL fails CORS checks. Cache-bust once.
    img.onerror = () => {
      if (retry) {
        loadImage(url + (url.includes('?') ? '&' : '?') + 'cors=1', false)
          .then(resolve, reject);
      } else {
        reject(new Error(`Image load failed: ${url}`));
      }
    };
    img.src = url;
  });
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const attempt = line ? `${line} ${word}` : word;
      if (ctx.measureText(attempt).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = attempt;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawLines(ctx, lines, x, y, lineHeight) {
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

/**
 * Render a creature (or land) card model to a receipt canvas.
 * @param {Object} card - card model from scryfall.js
 * @param {number} widthDots - printer width in dots (e.g. 576 for M250)
 * @param {Object} opts - {showOracle: bool, title: string|null}
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderCard(card, widthDots, { showOracle = true, title = null } = {}) {
  const w = widthDots;
  const contentW = w - PAD * 2;

  let artImg = null;
  if (card.art) {
    try {
      artImg = await loadImage(card.art);
    } catch (e) {
      console.warn('Art unavailable, printing text-only:', e.message);
    }
  }
  const artH = artImg ? Math.round(contentW * (artImg.height / artImg.width)) : 0;

  // Measure pass on a throwaway context
  const measure = document.createElement('canvas').getContext('2d');

  measure.font = 'bold 32px Georgia, serif';
  const nameLines = wrapText(measure, card.name, contentW);

  measure.font = '24px Georgia, serif';
  const typeLines = wrapText(measure, card.typeLine || '', contentW);

  measure.font = '22px Georgia, serif';
  const oracleLines = showOracle && card.oracleText ? wrapText(measure, card.oracleText, contentW) : [];

  const hasPT = card.power != null && card.toughness != null;
  const manaLine = card.manaCost ? 1 : 0;

  let height = PAD;
  if (title) height += 26;
  height += nameLines.length * 36 + 4;
  height += manaLine * 30;
  if (artImg) height += artH + 8;
  height += typeLines.length * 28 + 4;
  height += oracleLines.length * 27;
  if (hasPT) height += 46;
  height += 26 + PAD; // footer

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  let y = PAD;

  if (title) {
    ctx.font = 'bold 18px Courier New, monospace';
    ctx.fillText(title, PAD, y);
    y += 26;
  }

  ctx.font = 'bold 32px Georgia, serif';
  y = drawLines(ctx, nameLines, PAD, y, 36) + 4;

  if (manaLine) {
    ctx.font = 'bold 24px Courier New, monospace';
    ctx.fillText(`${card.manaCost}   (MV ${card.cmc})`, PAD, y);
    y += 30;
  }

  if (artImg) {
    ctx.drawImage(artImg, PAD, y, contentW, artH);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, y, contentW, artH);
    y += artH + 8;
  }

  ctx.font = '24px Georgia, serif';
  y = drawLines(ctx, typeLines, PAD, y, 28) + 4;

  if (oracleLines.length) {
    ctx.font = '22px Georgia, serif';
    y = drawLines(ctx, oracleLines, PAD, y, 27);
  }

  if (hasPT) {
    ctx.font = 'bold 40px Georgia, serif';
    const pt = `${card.power}/${card.toughness}`;
    ctx.fillText(pt, w - PAD - ctx.measureText(pt).width, y + 2);
    y += 46;
  }

  ctx.font = '16px Courier New, monospace';
  const footer = [card.set && `${card.set} #${card.cn}`, card.artist && `art: ${card.artist}`]
    .filter(Boolean).join('  ·  ');
  ctx.fillText(footer, PAD, y);

  return canvas;
}
