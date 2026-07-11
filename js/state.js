/**
 * State persistence for the tabletop tracker.
 *
 * The tracker is deliberately tiny — two life totals and a starting-life
 * setting — so a single localStorage blob is plenty. There is no digital
 * deck to preserve, so the old URL-hash game-backup layer is gone.
 */

const LS_KEY = 'momir_companion_game';
const SETTINGS_KEY = 'momir_companion_settings';

export const STATE_VERSION = 2;

export function newGameState(startingLife = 24) {
  return {
    v: STATE_VERSION,
    startingLife,
    life: [startingLife, startingLife],
  };
}

export function defaultSettings() {
  return {
    density: 6,
    feed: 40,
    contrast: 1.25,
    autoPrint: true,   // auto-print summoned creatures when a printer is connected
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
