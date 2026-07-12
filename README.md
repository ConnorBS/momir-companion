# 🎲 Momir Companion

**▶ Use it here: <https://connorbs.github.io/momir-companion/>**
(open in Chrome or Edge — desktop or Android — for printing)

A **tabletop life tracker** for **Momir Basic** that also prints random
creatures on a **Phomemo thermal printer** — straight from the browser over
Web Bluetooth. Lay your phone flat between two players; the top half is
rotated 180° so both people read their own life total right-side-up. No app,
no drivers, no server: it runs entirely as a static GitHub Pages site.

## How it plays

The app opens as a plain two-player life tracker; Momir features appear
once you start a game from the ⚙ menu.

- **Two-player life tracker** — a big number per side. Tap the left half of
  your side to subtract 1, the right half to add 1. A central ⚙ opens
  settings; **Reset both** snaps everyone back to the starting life.
- **New Momir game** — enables a **🎲 Summon** button per side, and
  optionally **landless play**: nobody brings lands, and each player draws
  from an identical tracked deck of basics (balanced across your chosen
  colors, independently shuffled). Each side's deck pad can **draw (1, 2,
  3, or a 7-card opening hand), scry 1–3, mill, and shuffle**, with a
  per-player graveyard whose lands can be **returned to play (reprinted)**
  — it behaves exactly like a real deck sitting there. Drawn lands **print
  automatically** (a random printing's art each time), so only cards that
  actually hit the table get printed; turn that off in settings if you use
  real land cards.
- **Print a Momir avatar** — prints one *Momir Vig, Simic Visionary*
  reference card with the activation rules and your chosen starting life;
  tap 🖨 Print again for the second player's copy.
- **Summon by tapping a number** — hit **🎲 Summon** on your side, then tell
  it *how much mana you're spending* (that's Momir's **X**). It rolls a
  random creature at that mana value and prints it. The summon pad and the
  card preview rotate to face whoever tapped. Card counts per X are hidden
  by default (reveal them in settings).
- **Pick your artwork** — 🎨 Other art cancels any in-progress auto-print
  and opens a gallery of every distinct art the card has ever had; the one
  you tap is the version that prints.
- **Momir rolls with correct odds** — every card *name* has an equal chance
  (selection uses Scryfall `oracle_cards` data, one entry per name). Once a
  name is chosen, the **art is a random printing from all of Magic history**.
- **High-contrast B&W receipts** — the card prints with the real art box,
  auto-leveled and Floyd–Steinberg dithered for thermal paper. No QR codes.
- **Refresh-proof** — life totals and settings autosave to localStorage.

## Printing

Uses the BLE transport and Phomemo raster protocol vendored from
[phomymo](https://github.com/transcriptionstream/phomymo)
(see `js/vendor/phomymo/NOTICE.md`). Tested target: **Phomemo M250**
(576 dots / 72mm print head); any BLE Phomemo the phomymo project supports
should work — the model is auto-detected from its Bluetooth name.

**Paper:** standard 2.25" (57mm) thermal receipt rolls work great and are
the default paper-width setting — cards render at ~56mm, close to a real
card's 63mm. The settings offer other widths up to the full 72mm head, and
a "continuous paper" toggle (on by default) tells the printer not to hunt
for die-cut label gaps. Content is centered on the head for narrower rolls.

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
