#!/usr/bin/env node
/**
 * Dependency-free self-test: `node scripts/selftest.mjs`
 *
 * Covers the two pieces that can break silently:
 *  • the land-deck maths in js/decks.js (draw/mill/scry/shuffle are the game),
 *  • the Scryfall bulk-data handling in scripts/build-index.mjs — the weekly
 *    refresh broke in 2026 when Scryfall retired the JSON `download_uri`, so
 *    the builder is run end-to-end against a local fake Scryfall.
 *
 * The browser UI is not covered here (it needs a real DOM + canvas).
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as Decks from '../js/decks.js';
import { isValidMomirCard, bucketFor, pickDownload } from './build-index.mjs';

const run = promisify(execFile);
const HERE = fileURLToPath(new URL('.', import.meta.url));
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
  }
}

// ---------------------------------------------------------------- decks.js

const COLORS = ['W', 'U', 'B', 'R', 'G'];

await test('balancedConfig always totals the requested deck size', () => {
  for (let n = 1; n <= 5; n++) {
    for (const size of [7, 12, 40, 60, 61, 200]) {
      const config = Decks.balancedConfig(COLORS.slice(0, n), size);
      const total = Object.values(config).reduce((a, b) => a + b, 0);
      assert.equal(total, size, `${n} colors, size ${size} -> ${total}`);
      const counts = Object.values(config);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `unbalanced: ${counts}`);
    }
  }
});

await test('buildDecks gives both players the same cards in different orders', () => {
  const decks = Decks.buildDecks(Decks.balancedConfig(COLORS, 60));
  const [a, b] = decks.libraries;
  assert.equal(a.length, 60);
  assert.equal(b.length, 60);
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.notDeepEqual(a, b);
  assert.deepEqual(decks.graveyards, [[], []]);
});

await test('draw removes the top card and stops at an empty library', () => {
  const decks = Decks.buildDecks({ W: 3 });
  const top = decks.libraries[0][0];
  assert.equal(Decks.draw(decks, 0), top);
  assert.equal(decks.libraries[0].length, 2);
  Decks.draw(decks, 0);
  Decks.draw(decks, 0);
  assert.equal(Decks.draw(decks, 0), null);
  assert.equal(decks.libraries[0].length, 0);
  assert.equal(decks.libraries[1].length, 3, 'the other player must be untouched');
});

await test('mill moves cards off the top into the graveyard, in order', () => {
  const decks = Decks.buildDecks(Decks.balancedConfig(COLORS, 10));
  const top3 = decks.libraries[0].slice(0, 3);
  assert.deepEqual(Decks.mill(decks, 0, 3), top3);
  assert.deepEqual(decks.graveyards[0].map((g) => g.c), top3);
  assert.ok(decks.graveyards[0].every((g) => g.via === 'mill'));
  assert.equal(decks.libraries[0].length, 7);
  assert.deepEqual(Decks.mill(decks, 0, 99).length, 7, 'mill stops at the last card');
  assert.deepEqual(Decks.mill(decks, 0, 3), [], 'milling an empty library is a no-op');
});

await test('peek does not disturb the library', () => {
  const decks = Decks.buildDecks(Decks.balancedConfig(COLORS, 10));
  const snapshot = [...decks.libraries[0]];
  assert.deepEqual(Decks.peek(decks, 0, 3), snapshot.slice(0, 3));
  assert.deepEqual(decks.libraries[0], snapshot);
});

await test('applyScry keeps every card and honours top/bottom order', () => {
  const decks = Decks.buildDecks(Decks.balancedConfig(COLORS, 10));
  const before = [...decks.libraries[0]];
  const [first, second, third] = Decks.peek(decks, 0, 3);
  // Player taps: third -> top, first -> top, second -> bottom
  Decks.applyScry(decks, 0, [third, first], [second]);
  const after = decks.libraries[0];
  assert.equal(after.length, before.length, 'scry must not change the deck size');
  assert.deepEqual([...after].sort(), [...before].sort(), 'scry must not change the cards');
  assert.equal(after[0], third, 'first tap is drawn first');
  assert.equal(after[1], first);
  assert.equal(after.at(-1), second, 'bottom pile goes under the rest');
  assert.deepEqual(after.slice(2, -1), before.slice(3), 'the untouched rest keeps its order');
});

await test('applyScry with everything sent to the bottom', () => {
  const decks = Decks.buildDecks(Decks.balancedConfig(COLORS, 6));
  const before = [...decks.libraries[0]];
  Decks.applyScry(decks, 0, [], before.slice(0, 2));
  assert.deepEqual(decks.libraries[0], [...before.slice(2), ...before.slice(0, 2)]);
});

await test('shuffleLibrary keeps the same cards', () => {
  const decks = Decks.buildDecks(Decks.balancedConfig(COLORS, 40));
  const before = [...decks.libraries[0]];
  Decks.shuffleLibrary(decks, 0);
  assert.deepEqual([...decks.libraries[0]].sort(), [...before].sort());
  Decks.mill(decks, 0, 40);
  Decks.shuffleLibrary(decks, 0); // must not throw on an empty library
  assert.equal(decks.libraries[0].length, 0);
});

await test('every basic land colour has a name for the UI to print', () => {
  assert.deepEqual(Object.keys(Decks.BASICS), COLORS);
  for (const c of COLORS) assert.ok(Decks.BASICS[c].name, `missing name for ${c}`);
});

// ---------------------------------------------------------------- index filter

const creature = (over = {}) => ({
  name: 'Llanowar Elves', oracle_id: 'o1', layout: 'normal', set_type: 'core',
  games: ['paper', 'arena'], type_line: 'Creature — Elf Druid', cmc: 1, ...over,
});

await test('the Momir filter keeps paper creatures and drops the rest', () => {
  assert.ok(isValidMomirCard(creature()));
  assert.ok(isValidMomirCard(creature({ type_line: 'Legendary Artifact Creature — Golem' })));
  assert.ok(isValidMomirCard(creature({
    type_line: undefined, card_faces: [{ type_line: 'Creature — Human' }, { type_line: 'Creature — Werewolf' }],
  })), 'multi-faced cards are judged on the front face');

  assert.ok(!isValidMomirCard(creature({ type_line: 'Instant' })), 'non-creature');
  assert.ok(!isValidMomirCard(creature({ layout: 'token' })), 'token layout');
  assert.ok(!isValidMomirCard(creature({ layout: 'vanguard' })), 'vanguard layout');
  assert.ok(!isValidMomirCard(creature({ set_type: 'funny' })), 'joke set');
  assert.ok(!isValidMomirCard(creature({ set_type: 'alchemy' })), 'digital rebalance');
  assert.ok(!isValidMomirCard(creature({ games: ['arena'] })), 'digital only');
  assert.ok(!isValidMomirCard(creature({ games: undefined })), 'no games list');
  assert.ok(!isValidMomirCard(creature({
    type_line: undefined, card_faces: [{ type_line: 'Enchantment' }, { type_line: 'Creature — Spirit' }],
  })), 'a back-face-only creature is not summonable');
});

await test('mana values are clamped into the buckets the app renders', () => {
  assert.equal(bucketFor(creature({ cmc: 0 })), 0);
  assert.equal(bucketFor(creature({ cmc: undefined })), 0);
  assert.equal(bucketFor(creature({ cmc: 3.5 })), 4, 'half mana values round');
  assert.equal(bucketFor(creature({ cmc: 16 })), 16);
  assert.equal(bucketFor(creature({ cmc: 1000000 })), 16, 'Gleemax clamps to the top bucket');
});

await test('pickDownload prefers JSONL and explains an unusable catalog', () => {
  assert.deepEqual(pickDownload({ jsonl_download_uri: 'j', download_uri: 'd' }), { uri: 'j', format: 'jsonl' });
  assert.deepEqual(pickDownload({ download_uri: 'd' }), { uri: 'd', format: 'json' });
  assert.throws(() => pickDownload({ object: 'bulk_data', size: 1 }), /jsonl_download_uri/);
  assert.throws(() => pickDownload(null), /neither/);
});

// -------------------------------------------------- builder against a fake API

/** Minimal stand-in for the Scryfall bulk-data endpoints. */
function fakeScryfall({ format = 'jsonl', cards }) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/bulk-data/oracle_cards')) {
      const body = {
        object: 'bulk_data', type: 'oracle_cards', updated_at: '2026-08-10T00:00:00.000+00:00', size: 1234,
      };
      const base = `http://127.0.0.1:${server.address().port}`;
      if (format === 'jsonl') body.jsonl_download_uri = `${base}/oracle.jsonl`;
      else body.download_uri = `${base}/oracle.json`;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    if (req.url === '/oracle.jsonl') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // Deliberately chunked mid-line to exercise the streaming line splitter.
      const text = `${cards.map((c) => JSON.stringify(c)).join('\n')}\n`;
      for (let i = 0; i < text.length; i += 7) res.write(text.slice(i, i + 7));
      return res.end();
    }
    if (req.url === '/oracle.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(cards));
    }
    res.writeHead(404); res.end('{}');
  });
  return server;
}

async function buildWith(server, args = []) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const out = await mkdtemp(join(tmpdir(), 'momir-index-'));
  try {
    const env = { ...process.env, SCRYFALL_API: `http://127.0.0.1:${server.address().port}` };
    const result = await run(process.execPath, [join(HERE, 'build-index.mjs'), '--out', out, ...args], { env });
    return { out, stdout: result.stdout, cleanup: () => rm(out, { recursive: true, force: true }) };
  } finally {
    server.close();
  }
}

const SAMPLE = [
  creature({ name: 'Memnite', oracle_id: 'o-memnite', cmc: 0 }),
  creature({ name: 'Llanowar Elves', oracle_id: 'o-llanowar', cmc: 1 }),
  creature({ name: 'Grizzly Bears', oracle_id: 'o-bears', cmc: 2 }),
  creature({ name: 'Autochthon Wurm', oracle_id: 'o-wurm', cmc: 15 }),
  creature({ name: 'Lightning Bolt', oracle_id: 'o-bolt', type_line: 'Instant', cmc: 1 }),
  creature({ name: 'Some Token', oracle_id: 'o-token', layout: 'token' }),
  creature({ name: 'Arena Only', oracle_id: 'o-arena', games: ['arena'] }),
];

await test('builder reads the current JSONL bulk format end to end', async () => {
  const { out, stdout, cleanup } = await buildWith(fakeScryfall({ format: 'jsonl', cards: SAMPLE }));
  try {
    const meta = JSON.parse(await readFile(join(out, 'meta.json'), 'utf8'));
    assert.equal(meta.total_creatures, 4, stdout);
    assert.deepEqual(meta.counts, { 0: 1, 1: 1, 2: 1, 15: 1 });
    assert.equal(meta.scryfall_updated_at, '2026-08-10T00:00:00.000+00:00');
    const bucket = JSON.parse(await readFile(join(out, 'cmc', '1.json'), 'utf8'));
    assert.deepEqual(bucket, [{ n: 'Llanowar Elves', id: 'o-llanowar' }]);
  } finally { await cleanup(); }
});

await test('builder still reads the legacy JSON array bulk format', async () => {
  const { out, cleanup } = await buildWith(fakeScryfall({ format: 'json', cards: SAMPLE }));
  try {
    const meta = JSON.parse(await readFile(join(out, 'meta.json'), 'utf8'));
    assert.equal(meta.total_creatures, 4);
  } finally { await cleanup(); }
});

await test('builder refuses to gut an existing index', async () => {
  const out = await mkdtemp(join(tmpdir(), 'momir-index-'));
  await mkdir(join(out, 'cmc'), { recursive: true });
  await writeFile(join(out, 'meta.json'), JSON.stringify({ total_creatures: 17000, counts: {} }));
  const server = fakeScryfall({ format: 'jsonl', cards: SAMPLE });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, SCRYFALL_API: `http://127.0.0.1:${server.address().port}` };
  try {
    await assert.rejects(
      run(process.execPath, [join(HERE, 'build-index.mjs'), '--out', out], { env }),
      /Refusing to shrink the index/,
    );
    const meta = JSON.parse(await readFile(join(out, 'meta.json'), 'utf8'));
    assert.equal(meta.total_creatures, 17000, 'the old index must survive a rejected build');
    // --force lets a genuine drop through
    await run(process.execPath, [join(HERE, 'build-index.mjs'), '--out', out, '--force'], { env });
    assert.equal(JSON.parse(await readFile(join(out, 'meta.json'), 'utf8')).total_creatures, 4);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

await test('builder fails loudly on a catalog with no download uri', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'bulk_data', type: 'oracle_cards', size: 1 }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const out = await mkdtemp(join(tmpdir(), 'momir-index-'));
  try {
    await assert.rejects(
      run(process.execPath, [join(HERE, 'build-index.mjs'), '--out', out], {
        env: { ...process.env, SCRYFALL_API: `http://127.0.0.1:${server.address().port}` },
      }),
      /jsonl_download_uri/,
    );
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- committed data

await test('the committed index matches its own meta.json', async () => {
  const root = new URL('../data/', import.meta.url);
  const meta = JSON.parse(await readFile(new URL('meta.json', root), 'utf8'));
  let total = 0;
  for (const [cmc, count] of Object.entries(meta.counts)) {
    const bucket = JSON.parse(await readFile(new URL(`cmc/${cmc}.json`, root), 'utf8'));
    assert.equal(bucket.length, count, `cmc ${cmc}: ${bucket.length} entries vs meta count ${count}`);
    assert.ok(bucket.every((e) => e.n && e.id), `cmc ${cmc} has entries missing a name or oracle id`);
    total += count;
  }
  assert.equal(total, meta.total_creatures);
  assert.ok(total > 15000, `only ${total} creatures indexed — the index looks truncated`);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
