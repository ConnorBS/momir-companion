#!/usr/bin/env node
/**
 * Build the Momir card index from Scryfall bulk data.
 *
 * Downloads the `oracle_cards` bulk file (one entry per card name), filters it
 * to Momir-Basic-legal creatures, and writes compact per-CMC buckets to
 * data/cmc/{n}.json plus data/meta.json.
 *
 * Filter rules ported from MoritzHayden/momir-basic-printer (MIT):
 * https://github.com/MoritzHayden/momir-basic-printer (src/scryfall.py)
 *
 * Usage: node scripts/build-index.mjs [--out data]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.scryfall.com';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'data';

// Layouts that are never Momir-summonable cards
const EXCLUDED_LAYOUTS = new Set([
  'token', 'emblem', 'art_series', 'double_faced_token',
  'scheme', 'planar', 'phenomenon', 'vanguard', 'augment', 'host',
]);

// Set types excluded from Momir (jokes, gold-border, digital-only rebalances)
const EXCLUDED_SET_TYPES = new Set(['funny', 'memorabilia', 'minigame', 'alchemy']);

function isValidMomirCard(card) {
  if (EXCLUDED_LAYOUTS.has(card.layout)) return false;
  if (EXCLUDED_SET_TYPES.has(card.set_type)) return false;
  if (!card.games || !card.games.includes('paper')) return false;
  // For multi-faced cards, Momir cares about the front face
  const typeLine = (card.card_faces?.[0]?.type_line ?? card.type_line ?? '').toLowerCase();
  return typeLine.includes('creature');
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'momir-companion/1.0', Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json();
}

console.log('Fetching bulk data catalog...');
const catalog = await fetchJson(`${API}/bulk-data/oracle_cards`);
console.log(`Downloading ${catalog.download_uri} (${Math.round(catalog.size / 1e6)} MB)...`);
const cards = await fetchJson(catalog.download_uri);
console.log(`${cards.length} oracle cards downloaded.`);

const buckets = new Map(); // cmc -> [{n, id}]
let kept = 0;
for (const card of cards) {
  if (!isValidMomirCard(card)) continue;
  const cmc = Math.min(16, Math.max(0, Math.round(card.cmc ?? 0)));
  if (!buckets.has(cmc)) buckets.set(cmc, []);
  buckets.get(cmc).push({ n: card.name, id: card.oracle_id });
  kept++;
}

await mkdir(join(OUT, 'cmc'), { recursive: true });
const counts = {};
for (const [cmc, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  list.sort((a, b) => a.n.localeCompare(b.n));
  counts[cmc] = list.length;
  await writeFile(join(OUT, 'cmc', `${cmc}.json`), JSON.stringify(list));
  console.log(`  cmc ${cmc}: ${list.length} creatures`);
}

await writeFile(join(OUT, 'meta.json'), JSON.stringify({
  built_at: new Date().toISOString(),
  scryfall_updated_at: catalog.updated_at,
  total_creatures: kept,
  counts,
}, null, 2));

console.log(`Done: ${kept} Momir-legal creatures across ${buckets.size} CMC buckets -> ${OUT}/`);
