/**
 * Momir Basic game logic. Pure state transitions — no DOM, no network.
 *
 * Zones: library (shuffled basics, index 0 = top), hand, lands (battlefield),
 * creatures (battlefield), graveyard, exile.
 */

export const BASICS = {
  W: { name: 'Plains', symbol: 'W' },
  U: { name: 'Island', symbol: 'U' },
  B: { name: 'Swamp', symbol: 'B' },
  R: { name: 'Mountain', symbol: 'R' },
  G: { name: 'Forest', symbol: 'G' },
};

// Deterministic PRNG so a game's shuffle can be reproduced from its seed
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(deck, seed) {
  const rand = mulberry32(seed);
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function addLog(state, msg) {
  state.log.push({ turn: state.turn, msg });
}

export function deckSize(config) {
  return Object.values(config).reduce((a, b) => a + b, 0);
}

/** Start a new game: build the land library, shuffle, draw an opening hand. */
export function startGame(state, deckConfig, startingLife = 24) {
  const deck = [];
  for (const [color, count] of Object.entries(deckConfig)) {
    for (let i = 0; i < count; i++) deck.push(color);
  }
  state.deckConfig = { ...deckConfig };
  state.seed = (Math.random() * 0xffffffff) >>> 0;
  state.library = shuffled(deck, state.seed);
  state.hand = [];
  state.lands = [];
  state.creatures = [];
  state.graveyard = [];
  state.exile = [];
  state.life = [startingLife, startingLife];
  state.turn = 1;
  state.landPlayed = false;
  state.log = [];
  state.started = true;
  addLog(state, `New game: ${deck.length}-land deck (${Object.entries(deckConfig).filter(([, n]) => n > 0).map(([c, n]) => `${n} ${BASICS[c].name}`).join(', ')}), ${startingLife} life`);
  for (let i = 0; i < 7; i++) draw(state, true);
  return state;
}

/** Draw the top land of the library into hand. Returns the color drawn, or null. */
export function draw(state, silent = false) {
  if (state.library.length === 0) return null;
  const color = state.library.shift();
  state.hand.push(color);
  if (!silent) addLog(state, `Drew ${BASICS[color].name}`);
  return color;
}

/** Mill N cards from the library to the graveyard. Returns the milled colors. */
export function mill(state, count) {
  const milled = [];
  for (let i = 0; i < count && state.library.length > 0; i++) {
    const color = state.library.shift();
    state.graveyard.push({ t: 'land', c: color, via: 'mill' });
    milled.push(color);
  }
  if (milled.length) addLog(state, `Milled ${milled.map(c => BASICS[c].name).join(', ')}`);
  return milled;
}

/** Play a land from hand onto the battlefield. */
export function playLand(state, handIndex) {
  const color = state.hand.splice(handIndex, 1)[0];
  state.lands.push(color);
  state.landPlayed = true;
  addLog(state, `Played ${BASICS[color].name}`);
  return color;
}

/** Discard a land from hand (Momir activation cost, cleanup, etc.). */
export function discard(state, handIndex, via = 'discard') {
  const color = state.hand.splice(handIndex, 1)[0];
  state.graveyard.push({ t: 'land', c: color, via });
  return color;
}

/**
 * Resolve a Momir activation: the discard already happened; put the fetched
 * random creature token onto the battlefield.
 * `card` = {name, cmc, set, cn, artist, typeLine, oracleText, power, toughness, manaCost, art, img}
 */
export function summon(state, x, card, discardedColor) {
  // uid derived from state so it survives save/restore without collisions
  const uid = Math.max(0, ...state.creatures.map(c => c.uid || 0), state._uidCounter || 0) + 1;
  state._uidCounter = uid;
  const creature = { uid, ...card };
  state.creatures.push(creature);
  addLog(state, `Momir X=${x} (discarded ${BASICS[discardedColor].name}): ${card.name} [${card.power ?? '-'}/${card.toughness ?? '-'}]`);
  return creature;
}

export function creatureDies(state, uid) {
  const i = state.creatures.findIndex(c => c.uid === uid);
  if (i < 0) return;
  const [creature] = state.creatures.splice(i, 1);
  state.graveyard.push({ t: 'creature', name: creature.name, cmc: creature.cmc, set: creature.set, cn: creature.cn });
  addLog(state, `${creature.name} died`);
}

export function creatureExiled(state, uid) {
  const i = state.creatures.findIndex(c => c.uid === uid);
  if (i < 0) return;
  const [creature] = state.creatures.splice(i, 1);
  state.exile.push({ t: 'creature', name: creature.name, cmc: creature.cmc });
  addLog(state, `${creature.name} exiled`);
}

export function landToGraveyard(state, landIndex, via = 'destroyed') {
  const [color] = state.lands.splice(landIndex, 1);
  state.graveyard.push({ t: 'land', c: color, via });
  addLog(state, `${BASICS[color].name} ${via}`);
}

export function changeLife(state, player, delta) {
  state.life[player] += delta;
}

export function nextTurn(state) {
  state.turn += 1;
  state.landPlayed = false;
  addLog(state, `— Turn ${state.turn} —`);
}

/** Mana available for Momir X (all basics tap for any color, so it's a count). */
export function manaAvailable(state) {
  return state.lands.length;
}
