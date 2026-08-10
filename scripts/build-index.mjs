#!/usr/bin/env node
/**
 * Build the Momir card index from Scryfall bulk data.
 *
 * Downloads the `oracle_cards` bulk file (one entry per card name), filters it
 * to Momir-Basic-legal creatures, and writes compact per-CMC buckets to
 * data/cmc/{n}.json plus data/meta.json.
 *
 * Scryfall retired the JSON array bulk files in 2026 in favour of JSONL
 * (one card per line), so the download is streamed line by line — the oracle
 * file is several hundred MB and never needs to be held in memory at once.
 * The older `download_uri` (JSON array) is still honoured if a response
 * happens to carry it.
 *
 * Filter rules ported from MoritzHayden/momir-basic-printer (MIT):
 * https://github.com/MoritzHayden/momir-basic-printer (src/scryfall.py)
 *
 * Usage: node scripts/build-index.mjs [--out data] [--force]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Overridable so the self-test can point the builder at a local fake Scryfall.
const API = process.env.SCRYFALL_API || 'https://api.scryfall.com';
const HEADERS = { 'User-Agent': 'momir-companion/1.0 (+https://github.com/ConnorBS/momir-companion)', Accept: '*/*' };

// A rebuild that loses more than this fraction of the index is treated as a
// bad download rather than a real change (card counts only ever grow).
const MIN_RETAINED_FRACTION = 0.9;

// Layouts that are never Momir-summonable cards
const EXCLUDED_LAYOUTS = new Set([
  'token', 'emblem', 'art_series', 'double_faced_token',
  'scheme', 'planar', 'phenomenon', 'vanguard', 'augment', 'host',
]);

// Set types excluded from Momir (jokes, gold-border, digital-only rebalances)
const EXCLUDED_SET_TYPES = new Set(['funny', 'memorabilia', 'minigame', 'alchemy']);

export function isValidMomirCard(card) {
  if (EXCLUDED_LAYOUTS.has(card.layout)) return false;
  if (EXCLUDED_SET_TYPES.has(card.set_type)) return false;
  if (!card.games || !card.games.includes('paper')) return false;
  // For multi-faced cards, Momir cares about the front face
  const typeLine = (card.card_faces?.[0]?.type_line ?? card.type_line ?? '').toLowerCase();
  return typeLine.includes('creature');
}

/** Clamp a card's mana value to the bucket range the app renders (0-16). */
export function bucketFor(card) {
  return Math.min(16, Math.max(0, Math.round(card.cmc ?? 0)));
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { ...HEADERS, Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json();
}

/**
 * Pick the bulk download to use. Scryfall's current bulk-data object exposes
 * `jsonl_download_uri` (newline-delimited); `download_uri` was the old JSON
 * array and is gone as of the 2026 bulk-data change.
 */
export function pickDownload(catalog) {
  if (catalog?.jsonl_download_uri) return { uri: catalog.jsonl_download_uri, format: 'jsonl' };
  if (catalog?.download_uri) return { uri: catalog.download_uri, format: 'json' };
  throw new Error(
    'Scryfall bulk-data object has neither jsonl_download_uri nor download_uri — '
    + `available keys: ${Object.keys(catalog ?? {}).join(', ') || '(none)'}`,
  );
}

/** Yield each non-empty line of a streamed response without buffering the body. */
async function* streamLines(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  if (!resp.body) throw new Error(`${url} -> empty response body`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of resp.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer.trim();
}

/** Iterate every card in the bulk file, whichever format Scryfall served. */
async function* eachCard({ uri, format }) {
  if (format === 'json') {
    const cards = await fetchJson(uri);
    yield* cards;
    return;
  }
  for await (const line of streamLines(uri)) {
    // A JSONL stream is one object per line; tolerate a stray array wrapper.
    if (line === '[' || line === ']') continue;
    yield JSON.parse(line.replace(/,$/, ''));
  }
}

async function previousTotal(out) {
  try {
    return JSON.parse(await readFile(join(out, 'meta.json'), 'utf8')).total_creatures ?? 0;
  } catch {
    return 0;
  }
}

async function main(argv = process.argv.slice(2)) {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'data';
  const force = argv.includes('--force');

  console.log('Fetching bulk data catalog...');
  const catalog = await fetchJson(`${API}/bulk-data/oracle_cards`);
  const download = pickDownload(catalog);
  const sizeMb = catalog.size ?? catalog.compressed_size;
  console.log(`Downloading ${download.format.toUpperCase()} ${download.uri}`
    + (sizeMb ? ` (${Math.round(sizeMb / 1e6)} MB)` : ''));

  const buckets = new Map(); // cmc -> [{n, id}]
  let seen = 0;
  let kept = 0;
  for await (const card of eachCard(download)) {
    seen++;
    if (!isValidMomirCard(card)) continue;
    const cmc = bucketFor(card);
    if (!buckets.has(cmc)) buckets.set(cmc, []);
    buckets.get(cmc).push({ n: card.name, id: card.oracle_id });
    kept++;
  }
  console.log(`${seen} oracle cards scanned, ${kept} Momir-legal creatures kept.`);

  if (seen === 0) throw new Error('Bulk file contained no cards — refusing to overwrite the index.');
  const before = await previousTotal(out);
  if (!force && before > 0 && kept < before * MIN_RETAINED_FRACTION) {
    throw new Error(
      `Refusing to shrink the index from ${before} to ${kept} creatures `
      + `(< ${Math.round(MIN_RETAINED_FRACTION * 100)}% retained). `
      + 'This usually means a truncated download or a Scryfall schema change. '
      + 'Re-run with --force if the drop is real.',
    );
  }

  await mkdir(join(out, 'cmc'), { recursive: true });
  const counts = {};
  for (const [cmc, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.n.localeCompare(b.n));
    counts[cmc] = list.length;
    await writeFile(join(out, 'cmc', `${cmc}.json`), JSON.stringify(list));
    console.log(`  cmc ${cmc}: ${list.length} creatures`);
  }

  await writeFile(join(out, 'meta.json'), `${JSON.stringify({
    built_at: new Date().toISOString(),
    scryfall_updated_at: catalog.updated_at,
    total_creatures: kept,
    counts,
  }, null, 2)}\n`);

  console.log(`Done: ${kept} Momir-legal creatures across ${buckets.size} CMC buckets -> ${out}/`);
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main();
