/**
 * Digital land decks for landless play.
 *
 * When "play without physical lands" is on, each player gets an identical
 * deck of basics (balanced across the chosen colors), independently
 * shuffled with a seeded PRNG and tracked so drawing is exactly like
 * drawing from a real deck — no replacement, mills and draws deplete it,
 * and everything survives a refresh via the saved state.
 */

export const BASICS = {
  W: { name: 'Plains' },
  U: { name: 'Island' },
  B: { name: 'Swamp' },
  R: { name: 'Mountain' },
  G: { name: 'Forest' },
};

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

/** Evenly split `size` lands across the chosen colors (remainder to the first ones). */
export function balancedConfig(colors, size) {
  const per = Math.floor(size / colors.length);
  let leftover = size - per * colors.length;
  const config = {};
  for (const c of colors) config[c] = per + (leftover-- > 0 ? 1 : 0);
  return config;
}

/** Build the two-player deck state: identical lists, independent shuffles. */
export function buildDecks(config) {
  const deck = [];
  for (const [color, count] of Object.entries(config)) {
    for (let i = 0; i < count; i++) deck.push(color);
  }
  const seed = (Math.random() * 0xffffffff) >>> 0;
  return {
    config: { ...config },
    seed,
    libraries: [shuffled(deck, seed), shuffled(deck, seed + 1)],
    graveyards: [[], []], // [{c, via: 'mill'|'discard'}]
    drawn: [0, 0],
  };
}

/** Draw the top land of player p's library. Returns the color or null. */
export function draw(decks, p) {
  const library = decks.libraries[p];
  if (!library.length) return null;
  decks.drawn[p] += 1;
  return library.shift();
}

/** Mill n lands from player p's library to their graveyard. Returns colors. */
export function mill(decks, p, n) {
  const milled = [];
  for (let i = 0; i < n && decks.libraries[p].length > 0; i++) {
    const color = decks.libraries[p].shift();
    decks.graveyards[p].push({ c: color, via: 'mill' });
    milled.push(color);
  }
  return milled;
}

/** Record a discard (e.g. Momir's cost) of a previously drawn land. */
export function discard(decks, p, color) {
  decks.graveyards[p].push({ c: color, via: 'discard' });
}
