/**
 * Scryfall client.
 *
 * Creature selection is two-step, matching Momir's actual odds:
 *  1. Uniform pick of a card NAME from the pre-built per-CMC index
 *     (data/cmc/{x}.json — one entry per oracle card, so every card name has
 *     an equal chance regardless of how many times it was printed).
 *  2. Uniform pick of a PRINTING of that name across all of Magic history,
 *     so the art that shows up could be from any set.
 */

const API = 'https://api.scryfall.com';
const bucketCache = new Map();

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Scryfall ${resp.status} for ${url}`);
  return resp.json();
}

export async function loadBucket(cmc) {
  if (bucketCache.has(cmc)) return bucketCache.get(cmc);
  let list = [];
  try {
    const resp = await fetch(`data/cmc/${cmc}.json`);
    if (resp.ok) list = await resp.json();
  } catch { /* missing bucket (e.g. cmc 14) -> empty */ }
  bucketCache.set(cmc, list);
  return list;
}

export async function bucketCount(cmc) {
  return (await loadBucket(cmc)).length;
}

/** Pick a random card name uniformly from the CMC bucket. */
export async function randomCreatureName(cmc) {
  const bucket = await loadBucket(cmc);
  if (bucket.length === 0) return null;
  return bucket[Math.floor(Math.random() * bucket.length)];
}

/** Fetch every paper printing of an oracle card (paginated). */
async function allPrintings(oracleId) {
  const query = encodeURIComponent(`oracleid:${oracleId} game:paper`);
  let url = `${API}/cards/search?q=${query}&unique=prints&order=released`;
  const prints = [];
  while (url) {
    const page = await fetchJson(url);
    prints.push(...page.data);
    url = page.has_more ? page.next_page : null;
  }
  return prints;
}

function faceOf(card) {
  // Front face carries the creature stats/art for multi-faced cards
  return card.card_faces && card.card_faces[0].image_uris ? card.card_faces[0] : card;
}

function toCardModel(printing, cmc) {
  const face = faceOf(printing);
  return {
    name: printing.name,
    cmc,
    year: (printing.released_at || '').slice(0, 4),
    illo: face.illustration_id ?? printing.illustration_id ?? null,
    manaCost: face.mana_cost ?? printing.mana_cost ?? '',
    typeLine: face.type_line ?? printing.type_line ?? '',
    oracleText: face.oracle_text ?? printing.oracle_text ?? '',
    power: face.power ?? printing.power ?? null,
    toughness: face.toughness ?? printing.toughness ?? null,
    set: printing.set.toUpperCase(),
    setName: printing.set_name,
    cn: printing.collector_number,
    artist: face.artist ?? printing.artist ?? '',
    art: face.image_uris?.art_crop ?? printing.image_uris?.art_crop ?? null,
    img: face.image_uris?.normal ?? printing.image_uris?.normal ?? null,
    oracleId: printing.oracle_id,
  };
}

/**
 * Full Momir roll: random name at CMC x, then a random printing of it.
 * Returns {card, printCount} or null if the bucket is empty.
 */
export async function rollCreature(cmc) {
  const pick = await randomCreatureName(cmc);
  if (!pick) return null;
  const prints = await allPrintings(pick.id);
  if (prints.length === 0) return null;
  const printing = prints[Math.floor(Math.random() * prints.length)];
  return { card: toCardModel(printing, cmc), printCount: prints.length };
}

/** Re-roll only the art/printing for an already-summoned card. */
export async function rerollPrinting(oracleId, cmc) {
  const prints = await allPrintings(oracleId);
  if (prints.length === 0) return null;
  const printing = prints[Math.floor(Math.random() * prints.length)];
  return toCardModel(printing, cmc);
}

/**
 * Every distinct artwork of a card (one printing per illustration),
 * oldest first — for the art picker gallery.
 */
export async function allArtworks(oracleId, cmc) {
  const prints = await allPrintings(oracleId);
  const seen = new Set();
  const out = [];
  for (const printing of prints) {
    const model = toCardModel(printing, cmc);
    if (!model.art) continue;
    const key = model.illo || `${model.set}-${model.cn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

/** Random printing of a named card (e.g. Momir Vig for the avatar art). */
export async function randomNamedPrinting(name) {
  const query = encodeURIComponent(`!"${name}" game:paper`);
  const printing = await fetchJson(`${API}/cards/random?q=${query}`);
  return toCardModel(printing, printing.cmc ?? 0);
}

const BASIC_NAMES = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/** Random printing of a basic land (random art across all of Magic history). */
export async function randomBasicLand(color) {
  const name = BASIC_NAMES[color];
  // /cards/random with a printing-level query is one request, vs. paginating
  // through hundreds of basic land printings
  const query = encodeURIComponent(`!"${name}" type:basic game:paper`);
  const printing = await fetchJson(`${API}/cards/random?q=${query}`);
  return toCardModel(printing, 0);
}
