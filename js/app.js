/**
 * Momir Companion — main UI wiring.
 */

import * as State from './state.js';
import * as Game from './game.js';
import * as Scryfall from './scryfall.js';
import * as Printing from './printing.js';
import { renderCard } from './receipt.js';
import { canvasToRaster, rasterToCanvas } from './dither.js';

let state = State.newGameState();
let settings = State.loadSettings();
const undoStack = [];
const MAX_UNDO = 30;

const $ = (id) => document.getElementById(id);
const MAX_X = 16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, ms);
}

function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function commit() {
  State.persist(state);
  render();
}

function closeDialogs() {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const bucketCounts = {};

async function loadBucketCounts() {
  try {
    const meta = await (await fetch('data/meta.json')).json();
    Object.assign(bucketCounts, meta.counts);
  } catch { /* meta is a nicety; buttons still work without it */ }
  renderMomirButtons();
}

function renderMomirButtons() {
  const container = $('momir-buttons');
  container.innerHTML = '';
  const mana = Game.manaAvailable(state);
  for (let x = 0; x <= MAX_X; x++) {
    const count = bucketCounts[x] ?? 0;
    if (x > 12 && count === 0) continue; // skip empty high-CMC buckets
    const btn = document.createElement('button');
    btn.innerHTML = `${x}<small>${count || '—'}</small>`;
    const affordable = x <= mana;
    if (affordable && count > 0) btn.classList.add('affordable');
    btn.disabled = count === 0 || state.hand.length === 0 ||
      (settings.enforceMana && !affordable);
    btn.addEventListener('click', () => startSummon(x));
    container.appendChild(btn);
  }
}

function landChip(color, label, onClick) {
  const chip = document.createElement('button');
  chip.className = `chip ${color}`;
  chip.textContent = label;
  if (onClick) chip.addEventListener('click', onClick);
  return chip;
}

function render() {
  $('setup').hidden = state.started;
  $('game').hidden = !state.started;
  $('life-0').textContent = state.life[0];
  $('life-1').textContent = state.life[1];
  $('turn-label').textContent = `Turn ${state.turn}`;
  if (!state.started) return;

  $('mana-count').textContent = state.lands.length;
  $('library-count').textContent = state.library.length;
  $('hand-count').textContent = state.hand.length;
  $('gy-count').textContent = state.graveyard.length;
  $('btn-draw').disabled = state.library.length === 0;

  renderMomirButtons();

  // Hand
  const hand = $('hand-chips');
  hand.innerHTML = '';
  state.hand.forEach((color, i) => {
    hand.appendChild(landChip(color, Game.BASICS[color].name, () => handAction(i)));
  });
  if (!state.hand.length) hand.innerHTML = '<span class="hint">Empty — no Momir activations possible</span>';

  // Battlefield lands, grouped by color
  const lands = $('land-chips');
  lands.innerHTML = '';
  const groups = {};
  state.lands.forEach((color) => { groups[color] = (groups[color] || 0) + 1; });
  for (const [color, n] of Object.entries(groups)) {
    lands.appendChild(landChip(color, `${Game.BASICS[color].name} ×${n}`, () => landAction(color)));
  }
  if (!state.lands.length) lands.innerHTML = '<span class="hint">No lands yet — play one from hand</span>';

  // Creatures
  const list = $('creature-list');
  list.innerHTML = '';
  for (const creature of state.creatures) {
    const row = document.createElement('div');
    row.className = 'creature';
    row.innerHTML = `
      ${creature.art ? `<img src="${creature.art}" alt="" loading="lazy" crossorigin="anonymous">` : ''}
      <span class="cname">${creature.name}
        <span class="csub">${creature.typeLine ?? ''} · ${creature.set} #${creature.cn}</span></span>
      <span class="cpt">${creature.power ?? '–'}/${creature.toughness ?? '–'}</span>`;
    const thumb = row.querySelector('img');
    if (thumb) {
      thumb.addEventListener('error', () => {
        // Recover from a cached non-CORS copy of the art (Scryfall vary: Origin)
        if (!thumb.src.includes('cors=1')) {
          thumb.src = `${creature.art}${creature.art.includes('?') ? '&' : '?'}cors=1`;
        } else {
          thumb.remove();
        }
      }, { once: false });
    }
    row.addEventListener('click', () => creatureAction(creature));
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------

let setupDeck = { W: 12, U: 12, B: 12, R: 12, G: 12 };

function renderSetup() {
  const builder = $('deck-builder');
  builder.innerHTML = '';
  for (const [color, info] of Object.entries(Game.BASICS)) {
    const row = document.createElement('div');
    row.className = 'deck-row';
    row.innerHTML = `
      <div class="swatch" style="background: var(--${color})"></div>
      <span class="lname">${info.name}</span>
      <button data-d="-1">−</button>
      <span class="cnt">${setupDeck[color]}</span>
      <button data-d="1">+</button>`;
    row.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      setupDeck[color] = Math.max(0, setupDeck[color] + Number(btn.dataset.d));
      renderSetup();
    }));
    builder.appendChild(row);
  }
  $('deck-total').textContent = Game.deckSize(setupDeck);
}

$('btn-balance').addEventListener('click', () => {
  const active = Object.keys(setupDeck).filter(c => setupDeck[c] > 0);
  const colors = active.length ? active : Object.keys(setupDeck);
  const per = Math.floor(60 / colors.length);
  for (const c of Object.keys(setupDeck)) setupDeck[c] = colors.includes(c) ? per : 0;
  let leftover = 60 - per * colors.length;
  for (const c of colors) { if (leftover-- > 0) setupDeck[c] += 1; }
  renderSetup();
});

$('btn-start').addEventListener('click', () => {
  if (Game.deckSize(setupDeck) < 7) { toast('Deck needs at least 7 lands'); return; }
  snapshot();
  Game.startGame(state, setupDeck, Number($('start-life').value) || 24);
  commit();
  toast('Shuffled. Drew 7 lands. Good luck!');
});

// ---------------------------------------------------------------------------
// Momir activation flow
// ---------------------------------------------------------------------------

let pendingX = null;

function startSummon(x) {
  if (state.hand.length === 0) { toast('No cards in hand to discard'); return; }
  pendingX = x;
  const chips = $('discard-chips');
  chips.innerHTML = '';
  state.hand.forEach((color, i) => {
    chips.appendChild(landChip(color, Game.BASICS[color].name, () => resolveSummon(i)));
  });
  $('dlg-discard').showModal();
}

async function resolveSummon(discardIndex) {
  const x = pendingX;
  closeDialogs();
  toast(`Summoning at X=${x}…`, 8000);
  try {
    const roll = await Scryfall.rollCreature(x);
    if (!roll) { toast(`No creatures exist at mana value ${x}`); return; }
    snapshot();
    const discardedColor = Game.discard(state, discardIndex, 'momir');
    const creature = Game.summon(state, x, roll.card, discardedColor);
    commit();
    await showCard(creature, {
      title: `MOMIR  X=${x}`,
      rollInfo: `1 of ${bucketCounts[x] ?? '?'} names · art ${roll.card.set} #${roll.card.cn} (1 of ${roll.printCount} printings)`,
      autoPrint: settings.autoPrintCreatures,
    });
  } catch (e) {
    console.error(e);
    toast(`Summon failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Card reveal + printing
// ---------------------------------------------------------------------------

let revealedCard = null;
let revealedTitle = null;

async function showCard(card, { title = null, rollInfo = '', autoPrint = false } = {}) {
  revealedCard = card;
  revealedTitle = title;
  const box = $('card-reveal');
  box.innerHTML = '<p class="hint">Rendering…</p>';
  $('dlg-card').showModal();

  const width = await Printing.printerWidthDots();
  try {
    const canvas = await renderCard(card, width, { title });
    // Preview exactly what the printer will produce
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
    box._printCanvas = canvas;
  } catch (e) {
    box.innerHTML = `<p class="warn">Preview failed: ${e.message}</p>`;
  }

  if (autoPrint && Printing.isPrinterConnected()) printRevealed();
}

async function printRevealed() {
  const box = $('card-reveal');
  if (!box._printCanvas) return;
  if (!Printing.isPrinterConnected()) {
    toast('Printer not connected — open 🖨 to connect');
    return;
  }
  const progress = $('print-progress');
  const bar = $('print-bar');
  progress.hidden = false;
  bar.style.width = '0%';
  try {
    await Printing.printCanvas(box._printCanvas, settings, p => { bar.style.width = `${p}%`; });
    toast('Printed ✓');
  } catch (e) {
    console.error(e);
    toast(`Print failed: ${e.message}`);
  } finally {
    progress.hidden = true;
  }
}

$('btn-print-card').addEventListener('click', printRevealed);

$('btn-reroll-art').addEventListener('click', async () => {
  if (!revealedCard?.oracleId) return;
  toast('Fetching another printing…');
  try {
    const fresh = await Scryfall.rerollPrinting(revealedCard.oracleId, revealedCard.cmc);
    if (!fresh) return;
    // Update the battlefield entry too, if this creature is on it
    const onField = state.creatures.find(c => c.uid === revealedCard.uid);
    if (onField) { Object.assign(onField, fresh); commit(); }
    Object.assign(revealedCard, fresh);
    await showCard(revealedCard, { title: revealedTitle });
  } catch (e) {
    toast(`Reroll failed: ${e.message}`);
  }
});

// ---------------------------------------------------------------------------
// Zone actions
// ---------------------------------------------------------------------------

/** Generic action sheet: title + labeled buttons. */
function actionSheet(title, actions) {
  $('sheet-title').textContent = title;
  const box = $('sheet-buttons');
  box.innerHTML = '';
  for (const action of actions) {
    if (!action) continue;
    const btn = document.createElement('button');
    btn.textContent = action.label;
    if (action.primary) btn.classList.add('primary');
    btn.disabled = !!action.disabled;
    btn.addEventListener('click', () => { $('dlg-sheet').close(); action.run(); });
    box.appendChild(btn);
  }
  $('dlg-sheet').showModal();
}

function handAction(index) {
  const color = state.hand[index];
  const name = Game.BASICS[color].name;
  actionSheet(`${name} (in hand)`, [
    {
      label: state.landPlayed ? '⛰ Play to battlefield (land already played!)' : '⛰ Play to battlefield',
      primary: !state.landPlayed,
      run: () => { snapshot(); Game.playLand(state, index); commit(); },
    },
    { label: '🗑 Discard', run: () => { snapshot(); Game.discard(state, index); commit(); } },
    { label: '🖨 Print this land', run: () => printLand(color) },
  ]);
}

function landAction(color) {
  actionSheet(`${Game.BASICS[color].name} (battlefield)`, [
    {
      label: '🪦 To graveyard (destroyed/sacrificed)',
      run: () => {
        const index = state.lands.indexOf(color);
        if (index < 0) return;
        snapshot();
        Game.landToGraveyard(state, index);
        commit();
      },
    },
    { label: '🖨 Print this land', run: () => printLand(color) },
  ]);
}

function creatureAction(creature) {
  actionSheet(`${creature.name} (${creature.power ?? '–'}/${creature.toughness ?? '–'})`, [
    { label: '🪦 Dies (to graveyard)', primary: true, run: () => { snapshot(); Game.creatureDies(state, creature.uid); commit(); } },
    { label: '✨ Exile', run: () => { snapshot(); Game.creatureExiled(state, creature.uid); commit(); } },
    { label: '👁 View / print', run: () => showCard(creature, { title: `MOMIR  X=${creature.cmc}` }) },
  ]);
}

async function printLand(color) {
  toast(`Fetching random ${Game.BASICS[color].name} art…`);
  try {
    const card = await Scryfall.randomBasicLand(color);
    await showCard(card, { title: 'LAND', autoPrint: settings.autoPrintLands });
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
}

$('btn-draw').addEventListener('click', async () => {
  snapshot();
  const color = Game.draw(state);
  commit();
  if (!color) return;
  toast(`Drew ${Game.BASICS[color].name}`);
  if (settings.autoPrintLands && Printing.isPrinterConnected()) printLand(color);
});

$('btn-mill').addEventListener('click', () => {
  const box = $('mill-buttons');
  box.innerHTML = '';
  for (const n of [1, 2, 3, 4, 5, 7, 10]) {
    const btn = document.createElement('button');
    btn.textContent = n;
    btn.addEventListener('click', () => {
      closeDialogs();
      snapshot();
      const milled = Game.mill(state, n);
      commit();
      toast(milled.length ? `Milled ${milled.length}: ${milled.map(c => Game.BASICS[c].symbol).join(' ')}` : 'Library is empty');
    });
    box.appendChild(btn);
  }
  $('dlg-mill').showModal();
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

document.querySelectorAll('.life-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    Game.changeLife(state, Number(btn.dataset.player), Number(btn.dataset.delta));
    commit();
  });
});

$('btn-next-turn').addEventListener('click', () => {
  snapshot();
  Game.nextTurn(state);
  commit();
});

// ---------------------------------------------------------------------------
// Panels: graveyard, log, menu
// ---------------------------------------------------------------------------

$('btn-graveyard').addEventListener('click', () => {
  const gyList = $('gy-list');
  gyList.innerHTML = state.graveyard.length ? '' : '<span class="hint">Empty</span>';
  for (const item of [...state.graveyard].reverse()) {
    const row = document.createElement('div');
    row.className = 'gy-item';
    row.innerHTML = item.t === 'land'
      ? `<span>${Game.BASICS[item.c].name}</span><span class="via">${item.via}</span>`
      : `<span>${item.name}</span><span class="via">creature · died</span>`;
    gyList.appendChild(row);
  }
  const exList = $('exile-list');
  exList.innerHTML = state.exile.length ? '' : '<span class="hint">Empty</span>';
  for (const item of [...state.exile].reverse()) {
    const row = document.createElement('div');
    row.className = 'gy-item';
    row.innerHTML = `<span>${item.name}</span><span class="via">exiled</span>`;
    exList.appendChild(row);
  }
  $('dlg-graveyard').showModal();
});

$('btn-log').addEventListener('click', () => {
  const list = $('log-list');
  list.innerHTML = state.log.length ? '' : '<span class="hint">Nothing yet</span>';
  for (const entry of [...state.log].reverse()) {
    const row = document.createElement('div');
    row.innerHTML = `<span class="lturn">T${entry.turn}</span> ${entry.msg}`;
    list.appendChild(row);
  }
  $('dlg-log').showModal();
});

$('btn-menu').addEventListener('click', () => $('dlg-menu').showModal());

$('btn-undo').addEventListener('click', () => {
  if (!undoStack.length) { toast('Nothing to undo'); return; }
  state = JSON.parse(undoStack.pop());
  State.persist(state);
  render();
  closeDialogs();
  toast('Undone');
});

$('btn-share').addEventListener('click', async () => {
  const url = await State.shareUrl(state);
  try {
    await navigator.clipboard.writeText(url);
    toast('Backup URL copied — open it anywhere to restore this game');
  } catch {
    prompt('Copy this URL:', url);
  }
});

$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
  closeDialogs();
});

$('btn-new-game').addEventListener('click', () => {
  if (!confirm('Abandon the current game and start a new one?')) return;
  snapshot();
  state = State.newGameState();
  State.clearSaved();
  State.persist(state);
  render();
  renderSetup();
  closeDialogs();
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
  $('set-autoprint-creatures').checked = settings.autoPrintCreatures;
  $('set-autoprint-lands').checked = settings.autoPrintLands;
  $('set-enforce-mana').checked = settings.enforceMana;
  const connected = Printing.isPrinterConnected();
  $('btn-connect').textContent = connected ? `Connected: ${Printing.printerName()}` : 'Connect Phomemo';
  $('printer-status').textContent = connected ? Printing.printerName() : 'Printer';
  const info = Printing.printerInfo();
  $('printer-detail').textContent = connected
    ? [info.battery != null && `battery ${info.battery}`, info.paper && `paper ${info.paper}`].filter(Boolean).join(' · ')
    : 'Not connected. Requires Chrome/Edge with Bluetooth.';
}

$('btn-printer').addEventListener('click', () => {
  $('no-bluetooth').hidden = Printing.isBluetoothAvailable();
  $('printer-panel').hidden = !Printing.isBluetoothAvailable();
  syncPrinterPanel();
  $('dlg-printer').showModal();
});

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

for (const [id, key, num] of [
  ['set-density', 'density', true],
  ['set-contrast', 'contrast', true],
  ['set-feed', 'feed', true],
]) {
  $(id).addEventListener('input', () => {
    settings[key] = num ? Number($(id).value) : $(id).value;
    State.saveSettings(settings);
    syncPrinterPanel();
  });
}
for (const [id, key] of [
  ['set-autoprint-creatures', 'autoPrintCreatures'],
  ['set-autoprint-lands', 'autoPrintLands'],
  ['set-enforce-mana', 'enforceMana'],
]) {
  $(id).addEventListener('change', () => {
    settings[key] = $(id).checked;
    State.saveSettings(settings);
    if (key === 'enforceMana') render();
  });
}

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

document.querySelectorAll('.dlg-close').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  const saved = await State.loadState();
  if (saved) state = saved;
  renderSetup();
  render();
  loadBucketCounts();
})();
