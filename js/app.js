/**
 * Momir Companion — tabletop life tracker + on-demand card printer.
 *
 * The phone sits flat between two players. Each half tracks a life total
 * (top half rotated 180°). The only Momir features are:
 *   • print two avatar reference cards at the start of a game, and
 *   • "how many lands did you tap?" → roll a random creature and print it.
 * Players bring their own basic-land deck (or print lands from the pad).
 */

import * as State from './state.js';
import * as Decks from './decks.js';
import * as Scryfall from './scryfall.js';
import * as Printing from './printing.js';
import { renderCard } from './receipt.js';
import { canvasToRaster, rasterToCanvas, rasterOpts } from './dither.js';

const $ = (id) => document.getElementById(id);
const MAX_X = 16;

let state = State.loadState() || State.newGameState();
let settings = State.loadSettings();
const bucketCounts = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast(msg, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, ms);
}

function commit() {
  State.persist(state);
  render();
}

function render() {
  $('life-0').textContent = state.life[0];
  $('life-1').textContent = state.life[1];
  // Momir controls appear only once a game has been set up
  document.querySelectorAll('.summon-btn').forEach((btn) => { btn.hidden = !state.momirActive; });
  document.querySelectorAll('.deck-btn').forEach((btn) => { btn.hidden = !state.momirActive || !state.decks; });
  if (state.decks) {
    $('deck-count-0').textContent = state.decks.libraries[0].length;
    $('deck-count-1').textContent = state.decks.libraries[1].length;
  }
}

// The Momir avatar isn't a paper card, so build a text-only reference card.
function momirAvatarCard(startingLife) {
  return {
    name: 'Momir Vig, Simic Visionary',
    cmc: '',
    manaCost: '',
    typeLine: 'Vanguard — Avatar',
    oracleText:
      "{X}, Discard a card: Create a token that's a copy of a random " +
      'creature card with mana value X. Activate only as a sorcery and ' +
      `only once each turn.\n\nStarting life ${startingLife}. ` +
      'Play from a deck of basic lands.',
    power: null,
    toughness: null,
    set: '',
    cn: '',
    artist: '',
    art: null,
  };
}

// ---------------------------------------------------------------------------
// Life tracking
// ---------------------------------------------------------------------------

document.querySelectorAll('.player .tap').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = Number(btn.dataset.player);
    state.life[p] += Number(btn.dataset.delta);
    commit();
  });
});

// ---------------------------------------------------------------------------
// Summon pad (per-player orientation)
// ---------------------------------------------------------------------------

const flipWrap = document.querySelector('#dlg-summon .flip-wrap');
let summonFlip = false;
let reveal = null; // { card, canvas, title, kind }

function setStage(name) {
  $('summon-stage').hidden = name !== 'summon';
  $('card-stage').hidden = name !== 'card';
  $('art-stage').hidden = name !== 'art';
}

function buildXButtons() {
  const grid = $('x-buttons');
  grid.innerHTML = '';
  const haveMeta = Object.keys(bucketCounts).length > 0;
  for (let x = 0; x <= MAX_X; x++) {
    const count = bucketCounts[x];
    if (haveMeta && !count) continue; // skip empty buckets (e.g. 14)
    const btn = document.createElement('button');
    btn.innerHTML = settings.hideCounts
      ? `${x}`
      : `${x}<small>${haveMeta ? count : '—'}</small>`;
    btn.addEventListener('click', () => doSummon(x));
    grid.appendChild(btn);
  }
}

function openSummonPad(player) {
  summonFlip = player === 1;
  flipWrap.classList.toggle('flip', summonFlip);
  setStage('summon');
  buildXButtons();
  if (!$('dlg-summon').open) $('dlg-summon').showModal();
}

document.querySelectorAll('.summon-btn').forEach((btn) => {
  btn.addEventListener('click', () => openSummonPad(Number(btn.dataset.player)));
});

async function doSummon(x) {
  setStage('card');
  $('card-reveal').innerHTML = `<p class="hint">Summoning at X=${x}…</p>`;
  try {
    const roll = await Scryfall.rollCreature(x);
    if (!roll) { toast(`No creatures exist at mana value ${x}`); openSummonPad(summonFlip ? 1 : 0); return; }
    await showReveal(roll.card, {
      title: `MOMIR  X=${x}`,
      kind: 'creature',
      autoPrint: settings.autoPrint,
      rollInfo: `1 of ${bucketCounts[x] ?? '?'} names · art ${roll.card.set} #${roll.card.cn} (1 of ${roll.printCount} printings)`,
    });
  } catch (e) {
    console.error(e);
    $('card-reveal').innerHTML = `<p class="warn">Summon failed: ${e.message}</p>`;
  }
}

/** Show a finished print canvas in the reveal stage; optionally auto-print. */
async function presentCanvas(canvas, { card = null, title = null, kind, autoPrint = false, copies = 1, rollInfo = '', grace = true }) {
  reveal = { card, title, kind, canvas };
  setStage('card');
  $('btn-reroll-art').hidden = kind !== 'creature' && kind !== 'land';
  $('btn-summon-again').hidden = kind !== 'creature';
  const box = $('card-reveal');
  if (!$('dlg-summon').open) $('dlg-summon').showModal();
  const preview = rasterToCanvas(canvasToRaster(canvas, rasterOpts(settings)));
  preview.style.width = '100%';
  box.innerHTML = '';
  box.appendChild(preview);
  if (rollInfo) {
    const info = document.createElement('div');
    info.className = 'roll-info';
    info.textContent = rollInfo;
    box.appendChild(info);
  }
  if (autoPrint && Printing.isPrinterConnected()) {
    await (grace ? autoPrintWithGrace(copies) : printReveal(copies));
  }
}

/**
 * Grace window before an auto-print transmits anything: a visible countdown
 * (0-5s, configurable) during which ANY touch on the screen cancels the
 * print outright — nothing is ever sent to the printer. Tapping 🖨 Print
 * still works immediately (the cancel fires first, then the button's click).
 */
function autoPrintWithGrace(copies = 1) {
  if (Printing.isPrintBusy()) {
    toast('🖨 A print is still in progress — tap Print when it finishes', 3500);
    return Promise.resolve();
  }
  const delay = Math.max(0, Math.min(5, settings.autoPrintDelay ?? 2));
  if (delay === 0) return printReveal(copies);

  return new Promise((resolve) => {
    const bar = $('autoprint-bar');
    let remaining = delay;
    $('autoprint-secs').textContent = remaining;
    bar.hidden = false;

    let tick, timer;
    const cleanup = () => {
      clearInterval(tick);
      clearTimeout(timer);
      document.removeEventListener('pointerdown', cancel, true);
      bar.hidden = true;
    };
    const cancel = () => {
      cleanup();
      toast('Auto-print cancelled — tap 🖨 Print when ready');
      resolve();
    };

    tick = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) $('autoprint-secs').textContent = remaining;
    }, 1000);
    timer = setTimeout(async () => {
      cleanup();
      await printReveal(copies);
      resolve();
    }, delay * 1000);
    document.addEventListener('pointerdown', cancel, { once: true, capture: true });
  });
}

/** Render a card into the reveal stage; optionally auto-print `copies`. */
async function showReveal(card, opts) {
  setStage('card');
  const box = $('card-reveal');
  box.innerHTML = '<p class="hint">Rendering…</p>';
  if (!$('dlg-summon').open) $('dlg-summon').showModal();
  const width = await Printing.printerWidthDots(settings);
  let canvas;
  try {
    canvas = await renderCard(card, width, { title: opts.title, symbol: opts.symbol || null });
  } catch (e) {
    box.innerHTML = `<p class="warn">Preview failed: ${e.message}</p>`;
    return;
  }
  await presentCanvas(canvas, { ...opts, card });
}

/** Stack per-card canvases into one continuous print with dashed cut lines. */
function stackCanvases(list, gap = 44) {
  const width = Math.max(...list.map((c) => c.width));
  const height = list.reduce((a, c) => a + c.height, 0) + gap * (list.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  list.forEach((c, i) => {
    ctx.drawImage(c, 0, y);
    y += c.height;
    if (i < list.length - 1) {
      ctx.strokeStyle = '#000';
      ctx.setLineDash([6, 10]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + gap / 2);
      ctx.lineTo(width, y + gap / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      y += gap;
    }
  });
  return canvas;
}

let printAbort = null; // aborts the in-flight/queued print when art is rerolled

async function printReveal(copies = 1) {
  if (!reveal?.canvas) return;
  if (!Printing.isPrinterConnected()) {
    toast('Printer not connected — open ⚙ to connect');
    return;
  }
  if (Printing.isPrintBusy()) {
    toast('🖨 A print is still in progress — wait for it to finish, then tap Print', 3500);
    return;
  }
  printAbort = new AbortController();
  const signal = printAbort.signal;
  const progress = $('print-progress');
  const bar = $('print-bar');
  progress.hidden = false;
  try {
    for (let i = 0; i < copies; i++) {
      bar.style.width = '0%';
      const result = await Printing.printCanvas(
        reveal.canvas, settings, (p) => { bar.style.width = `${p}%`; }, signal,
      );
      if (result === 'cancelled') { toast('Print cancelled'); return; }
    }
    toast(copies > 1 ? `Printed ${copies} ✓` : 'Printed ✓');
  } catch (e) {
    console.error(e);
    toast(`Print failed: ${e.message}`);
  } finally {
    progress.hidden = true;
  }
}

$('btn-print-card').addEventListener('click', () => printReveal(1));

$('btn-summon-again').addEventListener('click', () => openSummonPad(summonFlip ? 1 : 0));

// "Other art": stop any pending auto-print and open the artwork gallery —
// the printing you tap is exactly the version that renders and prints.
$('btn-reroll-art').addEventListener('click', async () => {
  if (!reveal?.card?.oracleId) return;
  printAbort?.abort();
  setStage('art');
  const grid = $('art-grid');
  grid.innerHTML = '<p class="hint">Loading printings…</p>';
  try {
    const artworks = await Scryfall.allArtworks(reveal.card.oracleId, reveal.card.cmc);
    grid.innerHTML = artworks.length ? '' : '<p class="sub">No other artwork found.</p>';
    for (const model of artworks) {
      const cell = document.createElement('button');
      cell.className = 'art-cell';
      cell.innerHTML = `
        <img src="${model.art}" alt="" loading="lazy" crossorigin="anonymous">
        <span>${model.set} · ${model.year}</span>`;
      const img = cell.querySelector('img');
      img.addEventListener('error', () => {
        if (!img.src.includes('cors=1')) {
          img.src = `${model.art}${model.art.includes('?') ? '&' : '?'}cors=1`;
        }
      });
      cell.addEventListener('click', () => {
        showReveal(model, { title: reveal.title, kind: reveal.kind });
      });
      grid.appendChild(cell);
    }
  } catch (e) {
    grid.innerHTML = `<p class="warn">Couldn't load printings: ${e.message}</p>`;
  }
});

$('btn-art-back').addEventListener('click', () => setStage('card'));

// ---------------------------------------------------------------------------
// Game setup (⚙ → New Momir game)
// ---------------------------------------------------------------------------

function renderSetupColors() {
  const row = $('setup-colors');
  if (row.childElementCount) return; // build once
  for (const [color, info] of Object.entries(Decks.BASICS)) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${color}" checked> ${info.name}`;
    row.appendChild(label);
  }
}

$('btn-new-game').addEventListener('click', () => {
  $('dlg-settings').close();
  renderSetupColors();
  $('setup-life').value = state.startingLife;
  $('setup-deck').hidden = !$('setup-landless').checked;
  $('dlg-setup').showModal();
});

$('setup-landless').addEventListener('change', () => {
  $('setup-deck').hidden = !$('setup-landless').checked;
});

$('btn-start-game').addEventListener('click', () => {
  const life = Math.max(1, Math.min(99, Number($('setup-life').value) || 24));
  state.startingLife = life;
  state.life = [life, life];
  state.momirActive = true;
  state.decks = null;
  if ($('setup-landless').checked) {
    const colors = [...document.querySelectorAll('#setup-colors input:checked')].map(cb => cb.value);
    if (!colors.length) { toast('Pick at least one land color'); return; }
    const size = Math.max(7, Math.min(200, Number($('setup-deck-size').value) || 60));
    state.decks = Decks.buildDecks(Decks.balancedConfig(colors, size));
  }
  commit();
  $('dlg-setup').close();
  toast(state.decks
    ? `Game on — two ${state.decks.libraries[0].length}-land decks shuffled`
    : `Game on — ${life} life each`);
});

$('btn-end-game').addEventListener('click', () => {
  state.momirActive = false;
  state.decks = null;
  commit();
  $('dlg-settings').close();
  toast('Back to plain life tracker');
});

// ---------------------------------------------------------------------------
// Land deck pad (landless mode)
// ---------------------------------------------------------------------------

let deckPlayer = 0;

function setDeckStage(name) {
  $('deck-stage').hidden = name !== 'deck';
  $('scry-stage').hidden = name !== 'scry';
}

function renderDeckPad() {
  const decks = state.decks;
  if (!decks) return;
  const remaining = decks.libraries[deckPlayer].length;
  $('deck-remaining').textContent = remaining;
  $('btn-draw').disabled = remaining === 0;
  for (const n of [1, 2, 3]) $(`btn-scry-${n}`).disabled = remaining < n;
  const gy = $('deck-gy');
  const items = decks.graveyards[deckPlayer];
  $('deck-gy-title').textContent = `Graveyard (${items.length})`;
  gy.innerHTML = items.length ? '' : '<p class="sub">Empty</p>';
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'gy-item';
    row.innerHTML = `
      <span>${Decks.BASICS[item.c].name}</span>
      <span class="gy-side"><span class="via">${item.via}</span>
      <button class="gy-get" title="Return to play (prints the land)">↩ 🖨</button></span>`;
    row.querySelector('.gy-get').addEventListener('click', async () => {
      items.splice(index, 1);
      commit();
      renderDeckPad();
      if (!settings.printLands && !Printing.isPrinterConnected()) {
        toast(`${Decks.BASICS[item.c].name} returned from graveyard`);
        return;
      }
      $('dlg-deck').close();
      await revealLand(item.c, 'returned from graveyard');
    });
    gy.prepend(row); // newest first
  });
}

document.querySelectorAll('.deck-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    deckPlayer = Number(btn.dataset.player);
    $('deck-flip').classList.toggle('flip', deckPlayer === 1);
    setDeckStage('deck');
    renderDeckPad();
    $('dlg-deck').showModal();
  });
});

/** Text-only land model — no network needed for symbol/text print styles. */
function landModel(color) {
  const name = Decks.BASICS[color].name;
  return {
    name,
    cmc: '',
    manaCost: '',
    typeLine: `Basic Land — ${name}`,
    oracleText: `{T}: Add {${color}}.`,
    power: null,
    toughness: null,
    set: '',
    cn: '',
    artist: '',
    art: null,
  };
}

/** Resolve a land card model + render options per the land-style setting. */
async function landCardFor(color) {
  const style = settings.landStyle || 'art';
  if (style === 'art') {
    try {
      return { card: await Scryfall.randomBasicLand(color), symbol: null };
    } catch (e) {
      console.warn('Land art unavailable, falling back to symbol:', e.message);
      return { card: landModel(color), symbol: color };
    }
  }
  return { card: landModel(color), symbol: style === 'symbol' ? color : null };
}

/** Open the (correctly flipped) reveal dialog and print one land. */
async function revealLand(color, rollInfo = '') {
  summonFlip = deckPlayer === 1;
  flipWrap.classList.toggle('flip', summonFlip);
  const { card, symbol } = await landCardFor(color);
  await showReveal(card, { title: 'LAND', kind: 'land', symbol, autoPrint: true, rollInfo });
}

async function drawMany(n) {
  const colors = [];
  for (let i = 0; i < n; i++) {
    const color = Decks.draw(state.decks, deckPlayer);
    if (!color) break;
    colors.push(color);
  }
  if (!colors.length) return;
  commit();
  renderDeckPad();
  const names = colors.map((c) => Decks.BASICS[c].name);

  if (!settings.printLands) {
    // Using real land cards — just report the draw
    toast(`Drew ${names.join(', ')}`, 4000);
    return;
  }
  $('dlg-deck').close();

  if (colors.length > 1 && !Printing.isPrinterConnected()) {
    // No printer: one summary reveal beats flashing 7 previews past the user
    summonFlip = deckPlayer === 1;
    flipWrap.classList.toggle('flip', summonFlip);
    setStage('card');
    if (!$('dlg-summon').open) $('dlg-summon').showModal();
    $('card-reveal').innerHTML =
      `<p>Drew ${colors.length}:</p><p><b>${names.join('<br>')}</b></p>` +
      '<p class="sub">Connect the printer (⚙) to auto-print drawn lands.</p>';
    reveal = null;
    return;
  }

  if (colors.length === 1) {
    await revealLand(colors[0]);
    return;
  }

  if (settings.batchDraws) {
    // Strip mode: ONE continuous print with dashed cut lines between cards.
    summonFlip = deckPlayer === 1;
    flipWrap.classList.toggle('flip', summonFlip);
    setStage('card');
    if (!$('dlg-summon').open) $('dlg-summon').showModal();
    $('card-reveal').innerHTML = `<p class="hint">Preparing ${colors.length} lands…</p>`;
    try {
      const width = await Printing.printerWidthDots(settings);
      const canvases = [];
      for (const color of colors) {
        const { card, symbol } = await landCardFor(color);
        canvases.push(await renderCard(card, width, { title: 'LAND', symbol }));
      }
      await presentCanvas(stackCanvases(canvases), {
        kind: 'batch',
        autoPrint: true,
        rollInfo: `${colors.length} lands drawn — dashed lines are cut marks`,
      });
    } catch (e) {
      $('card-reveal').innerHTML = `<p class="warn">Draw print failed: ${e.message}</p>`;
    }
    return;
  }

  // One card at a time: each print waits for the printer's ready signal
  // (or the timing estimate) before the next begins. No grace countdown —
  // drawing several lands is already a deliberate action.
  summonFlip = deckPlayer === 1;
  flipWrap.classList.toggle('flip', summonFlip);
  for (let i = 0; i < colors.length; i++) {
    const { card, symbol } = await landCardFor(colors[i]);
    await showReveal(card, {
      title: 'LAND',
      kind: 'land',
      symbol,
      autoPrint: true,
      grace: false,
      rollInfo: `drawn ${i + 1} of ${colors.length}`,
    });
  }
}

$('btn-draw').addEventListener('click', () => drawMany(1));
for (const n of [2, 3, 7]) {
  $(`btn-draw-${n}`).addEventListener('click', () => drawMany(n));
}

for (const n of [1, 3]) {
  $(`btn-mill-${n}`).addEventListener('click', () => {
    const milled = Decks.mill(state.decks, deckPlayer, n);
    commit();
    renderDeckPad();
    toast(milled.length
      ? `Milled ${milled.map(c => Decks.BASICS[c].name).join(', ')}`
      : 'Library is empty');
  });
}

$('btn-shuffle').addEventListener('click', () => {
  Decks.shuffleLibrary(state.decks, deckPlayer);
  commit();
  renderDeckPad();
  toast('Library shuffled');
});

// --- Scry: reveal top N, send each to top (tap order = draw order) or bottom ---

let scry = null; // { pending: [], topPile: [], bottomPile: [] }

function renderScry() {
  $('scry-title').textContent = `Scry ${scry.pending.length + scry.topPile.length + scry.bottomPile.length}`;
  const list = $('scry-list');
  list.innerHTML = '';
  scry.pending.forEach((color, i) => {
    const row = document.createElement('div');
    row.className = 'gy-item scry-item';
    row.innerHTML = `
      <span>${Decks.BASICS[color].name}${i === 0 ? ' <span class="via">(top)</span>' : ''}</span>
      <span class="scry-actions">
        <button data-pile="top">↑ Top</button>
        <button data-pile="bottom">↓ Bottom</button>
      </span>`;
    row.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
      scry.pending.splice(i, 1);
      scry[btn.dataset.pile === 'top' ? 'topPile' : 'bottomPile'].push(color);
      if (scry.pending.length === 0) finishScry();
      else renderScry();
    }));
    list.appendChild(row);
  });
  const describe = (pile) => pile.map((c) => Decks.BASICS[c].name).join(', ');
  $('scry-piles').textContent = [
    scry.topPile.length ? `Top: ${describe(scry.topPile)}` : '',
    scry.bottomPile.length ? `Bottom: ${describe(scry.bottomPile)}` : '',
  ].filter(Boolean).join('  ·  ');
}

function finishScry() {
  Decks.applyScry(state.decks, deckPlayer, scry.topPile, scry.bottomPile);
  const summary = `Scry done — ${scry.topPile.length} on top, ${scry.bottomPile.length} to bottom`;
  scry = null;
  commit();
  setDeckStage('deck');
  renderDeckPad();
  toast(summary);
}

for (const n of [1, 2, 3]) {
  $(`btn-scry-${n}`).addEventListener('click', () => {
    scry = { pending: Decks.peek(state.decks, deckPlayer, n), topPile: [], bottomPile: [] };
    if (!scry.pending.length) { scry = null; return; }
    setDeckStage('scry');
    renderScry();
  });
}

$('btn-scry-cancel').addEventListener('click', () => {
  scry = null; // library untouched until finishScry
  setDeckStage('deck');
  renderDeckPad();
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

$('btn-settings').addEventListener('click', () => {
  $('start-life').value = state.startingLife;
  $('btn-end-game').hidden = !state.momirActive;
  $('set-hide-counts').checked = settings.hideCounts;
  $('set-print-lands').checked = settings.printLands;
  $('set-avatar-art').checked = settings.avatarArt !== false;
  $('set-land-style').value = settings.landStyle || 'art';
  $('set-batch-draws').checked = !!settings.batchDraws;
  $('no-bluetooth').hidden = Printing.isBluetoothAvailable();
  $('printer-block').hidden = !Printing.isBluetoothAvailable();
  syncPrinterPanel();
  $('dlg-settings').showModal();
});

$('set-hide-counts').addEventListener('change', () => {
  settings.hideCounts = $('set-hide-counts').checked;
  State.saveSettings(settings);
});

$('set-print-lands').addEventListener('change', () => {
  settings.printLands = $('set-print-lands').checked;
  State.saveSettings(settings);
});

$('set-avatar-art').addEventListener('change', () => {
  settings.avatarArt = $('set-avatar-art').checked;
  State.saveSettings(settings);
});

$('set-land-style').addEventListener('change', () => {
  settings.landStyle = $('set-land-style').value;
  State.saveSettings(settings);
});

$('set-batch-draws').addEventListener('change', () => {
  settings.batchDraws = $('set-batch-draws').checked;
  State.saveSettings(settings);
});

$('start-life').addEventListener('change', () => {
  const life = Math.max(1, Math.min(99, Number($('start-life').value) || 24));
  state.startingLife = life;
  $('start-life').value = life;
  State.persist(state);
});

$('btn-reset-life').addEventListener('click', () => {
  state.life = [state.startingLife, state.startingLife];
  commit();
  toast(`Both players reset to ${state.startingLife}`);
});

$('btn-print-avatars').addEventListener('click', async () => {
  const connected = Printing.isPrinterConnected();
  const avatar = momirAvatarCard(state.startingLife);
  if (settings.avatarArt) {
    // Borrow the art box from a random printing of the real Momir Vig card
    try {
      const vig = await Scryfall.randomNamedPrinting('Momir Vig, Simic Visionary');
      Object.assign(avatar, { art: vig.art, artist: vig.artist, set: vig.set, cn: vig.cn });
    } catch (e) {
      console.warn('Momir art unavailable, printing text-only:', e.message);
    }
  }
  // One copy only — press 🖨 Print again for the second player's card
  await showReveal(avatar, {
    title: 'MOMIR BASIC — AVATAR',
    kind: 'avatar',
    autoPrint: connected,
    copies: 1,
  });
  if (!connected) toast('Printer not connected — showing preview.');
});

$('btn-fullscreen').addEventListener('click', () => {
  // The open modal's backdrop would swallow every tap in fullscreen
  $('dlg-settings').close();
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

// ---------------------------------------------------------------------------
// Screen wake lock
// ---------------------------------------------------------------------------
// A tabletop tracker must not dim mid-game — and if the screen sleeps during
// a 10-20s BLE transfer, Android suspends the page and the print stalls
// halfway with the connection dropped.

let wakeLock = null;

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* unsupported or denied — nothing to do */ }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!wakeLock || wakeLock.released)) keepAwake();
});

// ---------------------------------------------------------------------------
// Printer panel
// ---------------------------------------------------------------------------

function syncPrinterPanel() {
  $('set-paper-width').value = String(settings.paperWidthMm || 57);
  $('set-continuous').checked = settings.continuous !== false;
  $('set-offset').value = settings.offsetMm || 0;
  $('offset-val').textContent = `${settings.offsetMm > 0 ? '+' : ''}${settings.offsetMm || 0}mm`;
  $('set-dither').value = settings.dither || 'atkinson';
  $('set-density').value = settings.density;
  $('density-val').textContent = settings.density;
  $('set-brightness').value = settings.brightness ?? 1.15;
  $('brightness-val').textContent = Number(settings.brightness ?? 1.15).toFixed(2);
  $('set-contrast').value = settings.contrast;
  $('contrast-val').textContent = Number(settings.contrast).toFixed(2);
  $('set-feed').value = settings.feed;
  $('feed-val').textContent = settings.feed;
  $('set-fast').checked = !!settings.fastTransfer;
  $('set-autoprint').checked = settings.autoPrint;
  $('set-autoprint-delay').value = settings.autoPrintDelay ?? 2;
  $('autoprint-delay-val').textContent = `${settings.autoPrintDelay ?? 2}s`;
  const connected = Printing.isPrinterConnected();
  $('btn-connect').textContent = connected ? `Connected: ${Printing.printerName()}` : 'Connect Phomemo';
  const info = Printing.printerInfo();
  $('printer-detail').textContent = connected
    ? [info.battery != null && `battery ${info.battery}`, info.paper && `paper ${info.paper}`].filter(Boolean).join(' · ') || 'Connected.'
    : 'Not connected. Requires Chrome/Edge with Bluetooth.';
}

$('btn-connect').addEventListener('click', async () => {
  if (Printing.isPrinterConnected()) {
    await Printing.disconnectPrinter();
    syncPrinterPanel();
    return;
  }
  $('btn-connect').textContent = 'Connecting…';
  try {
    const { name, description } = await Printing.connectPrinter();
    Printing.onPrinterDisconnect(() => { syncPrinterPanel(); toast('Printer disconnected'); });
    toast(`Connected: ${name} (${description})`);
  } catch (e) {
    toast(`Connect failed: ${e.message}`);
  }
  syncPrinterPanel();
});

for (const [id, key] of [
  ['set-density', 'density'],
  ['set-brightness', 'brightness'],
  ['set-contrast', 'contrast'],
  ['set-feed', 'feed'],
  ['set-offset', 'offsetMm'],
  ['set-autoprint-delay', 'autoPrintDelay'],
]) {
  $(id).addEventListener('input', () => {
    settings[key] = Number($(id).value);
    State.saveSettings(settings);
    syncPrinterPanel();
  });
}

$('set-dither').addEventListener('change', () => {
  settings.dither = $('set-dither').value;
  State.saveSettings(settings);
});

$('set-fast').addEventListener('change', () => {
  settings.fastTransfer = $('set-fast').checked;
  State.saveSettings(settings);
});

$('set-autoprint').addEventListener('change', () => {
  settings.autoPrint = $('set-autoprint').checked;
  State.saveSettings(settings);
});

$('set-paper-width').addEventListener('change', () => {
  settings.paperWidthMm = Number($('set-paper-width').value) || 57;
  State.saveSettings(settings);
});

$('set-continuous').addEventListener('change', () => {
  settings.continuous = $('set-continuous').checked;
  State.saveSettings(settings);
});

$('btn-test-print').addEventListener('click', async () => {
  // Calibration pattern: a border box at the configured paper width with
  // edge arrows — if either side is cut off, adjust the Position slider.
  const width = await Printing.printerWidthDots(settings);
  const height = 170;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.strokeRect(1, 1, width - 3, height - 3);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 26px Georgia, serif';
  ctx.fillText('Momir Companion', 16, 14);
  ctx.font = '18px Courier New, monospace';
  ctx.fillText(`${settings.paperWidthMm}mm · density ${settings.density}`, 16, 52);
  ctx.fillText(`${settings.dither} · offset ${settings.offsetMm > 0 ? '+' : ''}${settings.offsetMm || 0}mm`, 16, 76);
  ctx.font = 'bold 20px Courier New, monospace';
  ctx.fillText('<LEFT', 8, height - 38);
  ctx.fillText('RIGHT>', width - 8 - ctx.measureText('RIGHT>').width, height - 38);
  ctx.font = '16px Courier New, monospace';
  const hint = 'box cut off? adjust Position';
  ctx.fillText(hint, Math.round((width - ctx.measureText(hint).width) / 2), height - 112);
  try {
    await Printing.printCanvas(canvas, settings);
    toast('Calibration sent — if the box is cut off, adjust Position');
  } catch (e) {
    toast(`Test failed: ${e.message}`);
  }
});

// ---------------------------------------------------------------------------
// Dialog close buttons
// ---------------------------------------------------------------------------

document.querySelectorAll('.dlg-close').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadBucketCounts() {
  try {
    const meta = await (await fetch('data/meta.json')).json();
    Object.assign(bucketCounts, meta.counts);
  } catch { /* buttons still work without counts */ }
}

render();
loadBucketCounts();
keepAwake();
