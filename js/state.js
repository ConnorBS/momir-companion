/**
 * Game state persistence.
 *
 * Two redundant layers so an accidental refresh never loses a game:
 *  1. localStorage — written synchronously on every action.
 *  2. URL hash — deflate-compressed base64url snapshot, updated (debounced)
 *     via history.replaceState. Copying the URL is a full game backup that
 *     can be opened on another device.
 *
 * On load, the URL hash wins over localStorage (so a shared/bookmarked link
 * restores exactly that game).
 */

const LS_KEY = 'momir_companion_game';
const SETTINGS_KEY = 'momir_companion_settings';

export function newGameState() {
  return {
    v: 1,
    started: false,
    deckConfig: { W: 12, U: 12, B: 12, R: 12, G: 12 },
    seed: 0,
    library: [],
    hand: [],
    lands: [],       // battlefield lands (basic type letters)
    creatures: [],   // battlefield creatures
    graveyard: [],   // {t:'land', c, via} | {t:'creature', name, cmc, set, cn}
    exile: [],
    life: [24, 24],  // Momir vanguard starts at 24
    turn: 1,
    landPlayed: false,
    log: [],
  };
}

export function defaultSettings() {
  return {
    density: 6,
    feed: 40,
    contrast: 1.25,
    autoPrintCreatures: true,
    autoPrintLands: false,
    enforceMana: true,
  };
}

export function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function saveLocal(state) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

export function clearSaved() {
  localStorage.removeItem(LS_KEY);
  history.replaceState(null, '', location.pathname + location.search);
}

// --- URL hash encoding (deflate + base64url) ---

async function compress(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decompress(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

let hashTimer = null;

export function saveHash(state) {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(async () => {
    try {
      const encoded = await compress(JSON.stringify(state));
      history.replaceState(null, '', `#g=${encoded}`);
    } catch (e) {
      console.warn('URL hash save failed:', e);
    }
  }, 400);
}

export async function loadState() {
  const match = location.hash.match(/#g=([A-Za-z0-9_-]+)/);
  if (match) {
    try {
      const state = JSON.parse(await decompress(match[1]));
      if (state && state.v === 1) return state;
    } catch (e) {
      console.warn('URL hash restore failed, falling back to localStorage:', e);
    }
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (state && state.v === 1) return state;
    }
  } catch { /* corrupted save */ }
  return null;
}

export function persist(state) {
  saveLocal(state);
  saveHash(state);
}

export async function shareUrl(state) {
  const encoded = await compress(JSON.stringify(state));
  return `${location.origin}${location.pathname}${location.search}#g=${encoded}`;
}
