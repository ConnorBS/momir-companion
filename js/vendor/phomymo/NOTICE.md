# Vendored code: phomymo

The files in this directory (`ble.js`, `printer.js`, `printers.json`) are vendored
from the [phomymo](https://github.com/transcriptionstream/phomymo) project by
transcriptionstream — a browser-based label designer that prints to Phomemo
thermal printers over Web Bluetooth.

- Upstream repo: https://github.com/transcriptionstream/phomymo
- Vendored from the `master` branch, July 2026.
- Upstream license: the project README declares the MIT License
  (`package.json` declares ISC); both are permissive licenses permitting
  redistribution with attribution. No standalone LICENSE file exists upstream
  as of the vendoring date.

Local modifications (kept intentionally minimal so upstream updates can be
re-vendored by copying the files over):

1. `printer.js` — `loadPrinterDefinitions()` accepts an optional URL for
   `printers.json` instead of assuming it sits next to `index.html`.
2. `constants.js` — trimmed to only the sections these modules import
   (`BLE`, `STORAGE_KEYS`); the upstream file also contains UI-editor
   constants that are not used here.

Everything else is unmodified upstream code. Thank you, transcriptionstream!
