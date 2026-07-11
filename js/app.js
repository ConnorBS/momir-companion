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
import * as Scryfall from './scryfall.js';
import * as Printing from './printing.js';
import { renderCard } from './receipt.js';
import { canvasToRaster, rasterToCanvas } from './dither.js';

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
}

function buildXButtons() {
  const grid = $('x-buttons');
  grid.innerHTML = '';
  const haveMeta = Object.keys(bucketCounts).length > 0;
  for (let x = 0; x <= MAX_X; x++) {
    const count = bucketCounts[x];
    if (haveMeta && !count) continue; // skip empty buckets (e.g. 14)
    const btn = document.createElement('button');
    btn.innerHTML = `${x}<small>${haveMeta ? count : '—'}</small>`;
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

/** Render a card into the reveal stage; optionally auto-print `copies`. */
async function showReveal(card, { title, kind, autoPrint = false, copies = 1, rollInfo = '' }) {
  reveal = { card, title, kind, canvas: null };
  setStage('card');
  $('btn-reroll-art').hidden = kind !== 'creature';
  $('btn-summon-again').hidden = kind !== 'creature';
  const box = $('card-reveal');
  box.innerHTML = '<p class="hint">Rendering…</p>';
  if (!$('dlg-summon').open) $('dlg-summon').showModal();

  const width = await Printing.printerWidthDots();
  try {
    const canvas = await renderCard(card, width, { title });
    reveal.canvas = canvas;
    const preview = rasterToCanvas(canvasToRaster(canvas, { contrast: settings.contrast }));
    preview.style.width = '100%';
    box.innerHTML = '';
    box.appendChild(preview);
    if (rollInfo) {
      const info = document.createElement('div');
      info.className = 'roll-info';
      info.textContent = rollInfo;
      box.appendChild(info);
    }
  } catch (e) {
    box.innerHTML = `<p class="warn">Preview failed: ${e.message}</p>`;
    return;
  }

  if (autoPrint && Printing.isPrinterConnected()) await printReveal(copies);
}

async function printReveal(copies = 1) {
  if (!reveal?.canvas) return;
  if (!Printing.isPrinterConnected()) {
    toast('Printer not connected — open ⚙ to connect');
    return;
  }
  const progress = $('print-progress');
  const bar = $('print-bar');
  progress.hidden = false;
  try {
    for (let i = 0; i < copies; i++) {
      bar.style.width = '0%';
      await Printing.printCanvas(reveal.canvas, settings, (p) => { bar.style.width = `${p}%`; });
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

$('btn-reroll-art').addEventListener('click', async () => {
  if (!reveal?.card?.oracleId) return;
  toast('Fetching another printing…');
  try {
    const fresh = await Scryfall.rerollPrinting(reveal.card.oracleId, reveal.card.cmc);
    if (!fresh) return;
    await showReveal(fresh, { title: reveal.title, kind: 'creature' });
  } catch (e) {
    toast(`Reroll failed: ${e.message}`);
  }
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

$('btn-settings').addEventListener('click', () => {
  $('start-life').value = state.startingLife;
  $('no-bluetooth').hidden = Printing.isBluetoothAvailable();
  $('printer-block').hidden = !Printing.isBluetoothAvailable();
  syncPrinterPanel();
  $('dlg-settings').showModal();
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
  await showReveal(momirAvatarCard(state.startingLife), {
    title: 'MOMIR BASIC — AVATAR',
    kind: 'avatar',
    autoPrint: connected,
    copies: 2,
  });
  if (!connected) toast('Printer not connected — showing preview. Tap 🖨 Print per copy.');
});

$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

// ---------------------------------------------------------------------------
// Printer panel
// ---------------------------------------------------------------------------

function syncPrinterPanel() {
  $('set-density').value = settings.density;
  $('density-val').textContent = settings.density;
  $('set-contrast').value = settings.contrast;
  $('contrast-val').textContent = Number(settings.contrast).toFixed(2);
  $('set-feed').value = settings.feed;
  $('feed-val').textContent = settings.feed;
  $('set-autoprint').checked = settings.autoPrint;
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
  ['set-contrast', 'contrast'],
  ['set-feed', 'feed'],
]) {
  $(id).addEventListener('input', () => {
    settings[key] = Number($(id).value);
    State.saveSettings(settings);
    syncPrinterPanel();
  });
}

$('set-autoprint').addEventListener('change', () => {
  settings.autoPrint = $('set-autoprint').checked;
  State.saveSettings(settings);
});

$('btn-test-print').addEventListener('click', async () => {
  const width = await Printing.printerWidthDots();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, 120);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 36px Georgia, serif';
  ctx.fillText('Momir Companion', 8, 20);
  ctx.font = '20px Courier New, monospace';
  ctx.fillText(`${width} dots wide · density ${settings.density}`, 8, 70);
  try {
    await Printing.printCanvas(canvas, settings);
    toast('Test sent ✓');
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
