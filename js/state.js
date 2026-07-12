/**
 * State persistence for the tabletop tracker.
 *
 * The tracker is deliberately tiny — two life totals and a starting-life
 * setting — so a single localStorage blob is plenty. There is no digital
 * deck to preserve, so the old URL-hash game-backup layer is gone.
 */

const LS_KEY = 'momir_companion_game';
const SETTINGS_KEY = 'momir_companion_settings';

export const STATE_VERSION = 3;

export function newGameState(startingLife = 24) {
  return {
    v: STATE_VERSION,
    startingLife,
    life: [startingLife, startingLife],
    momirActive: false, // summon buttons appear only after "New Momir game"
    decks: null,        // deck state from decks.js when playing without physical lands
  };
}

export function defaultSettings() {
  return {
    density: 5,        // 6+ tends to bleed and muddy the art on receipt paper
    feed: 40,
    contrast: 1.25,
    brightness: 1.15,  // gamma lift to offset thermal dot gain
    dither: 'atkinson',
    offsetMm: 0,       // horizontal calibration nudge (positive = right)
    fastTransfer: false,
    autoPrint: true,   // auto-print summoned creatures when a printer is connected
    hideCounts: true,  // hide card counts on the summon pad (off to reveal them)
    printLands: true,  // print drawn lands (turn off when using real land cards)
    paperWidthMm: 57,  // roll width; content renders at this and centers on the head
    continuous: true,  // gapless media (receipt rolls) vs die-cut labels
    avatarArt: true,   // put real Momir Vig card art on the avatar reference card
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

export function persist(state) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

export function clearSaved() {
  localStorage.removeItem(LS_KEY);
}

export function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (state && state.v === STATE_VERSION && Array.isArray(state.life)) return state;
    }
  } catch { /* corrupted save */ }
  return null;
}
