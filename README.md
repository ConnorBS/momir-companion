# 🎲 Momir Companion

A fullscreen **Momir Basic** game tracker that prints your random creatures
(and lands) on a **Phomemo thermal printer** — straight from the browser over
Web Bluetooth. No app, no drivers, no server: it runs entirely as a static
GitHub Pages site.

## Why

Physical Momir Basic normally needs two 60-card stacks of basic lands and some
way to reveal random creatures. This app replaces all of that:

- **Digital land deck** — build a balanced deck of basics, seeded-shuffled.
  Draw, play, discard, and mill lands digitally; **print only the cards that
  actually hit the table**, instead of sleeving 120 lands.
- **Momir rolls with correct odds** — every card *name* has an equal chance
  (selection uses Scryfall `oracle_cards` data, one entry per name). Once a
  name is chosen, the **art is a random printing from all of Magic history**.
- **High-contrast B&W receipts** — the card prints with the real art box,
  auto-leveled and Floyd–Steinberg dithered for thermal paper. No QR codes.
- **Full game tracking** — life totals (starts at 24, Momir's vanguard
  bonus), turn counter, hand, battlefield, graveyard and exile viewers,
  and a complete game log.
- **Refresh-proof** — state autosaves to localStorage on every action *and*
  is encoded into the URL hash, so a copied URL is a full game backup you can
  reopen on any device.

## Printing

Uses the BLE transport and Phomemo raster protocol vendored from
[phomymo](https://github.com/transcriptionstream/phomymo)
(see `js/vendor/phomymo/NOTICE.md`). Tested target: **Phomemo M250**
(576 dots wide); any BLE Phomemo the phomymo project supports should work —
the model is auto-detected from its Bluetooth name.

Requirements: Chrome or Edge (desktop or Android) — Web Bluetooth is not
available on iOS/Safari/Firefox. The site must be served over HTTPS
(GitHub Pages is), and connecting requires one tap on the printer picker.

No printer? Everything still works as a tracker; you can also screenshot the
card preview and share it to the official Phomemo app.

## Card data

`scripts/build-index.mjs` downloads Scryfall's `oracle_cards` bulk file and
filters it to Momir-legal creatures (filter rules ported from
[momir-basic-printer](https://github.com/MoritzHayden/momir-basic-printer)
by Hayden Moritz, MIT): excludes tokens/emblems/schemes/etc., funny and
gold-border sets, Alchemy rebalances, and anything not available in paper.
The result is committed as small per-CMC JSON buckets in `data/cmc/`, and a
GitHub Action refreshes them weekly.

At game time the app only makes two kinds of Scryfall API calls: fetching all
printings of the rolled card name (to pick random art) and fetching a random
basic-land printing.

## Development

No build step. Serve the repo root and open it:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

Rebuild the card index manually with:

```sh
node scripts/build-index.mjs
```

## Credits & legal

- Card data and images © Wizards of the Coast, served by
  [Scryfall](https://scryfall.com). This project is unofficial Fan Content
  permitted under the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy);
  it is not approved or endorsed by Wizards.
- Momir filter logic ported from
  [MoritzHayden/momir-basic-printer](https://github.com/MoritzHayden/momir-basic-printer) (MIT).
- Phomemo Web Bluetooth printing vendored from
  [transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo).

Licensed MIT — see [LICENSE](LICENSE).
