# StickMotion

A browser-based stick-figure animator in the style of Pivot Animator, built for classroom use. Students pose figures, press Space to add frames, and export GIFs, WebM video or PNG frames. Everything runs in the browser: no accounts, no server, and no internet connection once the page has loaded.

**Live site:** https://kiwispin.github.io/stick-motion/ (served by GitHub Pages from the `main` branch)

## Run it locally

The app loads its code as JavaScript modules, so it must be served over HTTP. Opening `index.html` directly from the file system will not work.

```bash
npm start
```

Then open http://127.0.0.1:4173/index.html. `npm start` uses a small dependency-free Node server (`tests/static-server.mjs`); any static file server pointed at the project folder works too.

## Test it

```bash
npm install
npx playwright install chromium
npm run test:unit
npm run test:e2e
```

- **Unit tests** (`tests/*.test.mjs`) cover project storage, GIF timing, ZIP export and the `.stk` importer.
- **Real Pivot figures:** put `.stk` files in a `stk/` folder at the project root to test against them. Every `.stk` there is checked to decode, draw, and survive saving and reopening, and the sheep, basketball hoop and Spider-Man files have detailed checks of their own (which skip when the files are absent). The folder is git-ignored because the figures are other people's work.
- **The whole Pivot STK library:** with the library test set in `stk/library/`, `npm run test:stk-corpus` reports how many of its 1,125 figures import (1,052 at the last count) and flags any figure whose import or drawing changed since the saved baseline. See `STK-LIBRARY-CHANGE-LOG.md`.
- **Browser tests** (`tests/e2e/`) drive the real editor in Chromium. Playwright starts the local server automatically.

## Deploy

Pushing to `main` publishes to the live site within a minute or two, and students get the new version on their next page load. Deploy outside lesson time, and ask students to refresh once so any tab still running the old version picks up the update.

## How it fits together

| Path | Purpose |
| --- | --- |
| `index.html` | The editor UI and the main `app` object (stage, timeline, playback, exports, dialogs) |
| `src/models.js` | `Joint`, `Figure` and `FigureGroup`: figures are trees of joints posed by angle |
| `src/project.js` | Project file format, validation and size limits |
| `src/storage.js` | Autosave to IndexedDB (one current draft plus a backup slot for drafts that fail to reopen) |
| `src/history.js` | Undo and redo |
| `src/stk-import.js`, `src/stk-renderer.js` | Importing and drawing Pivot `.stk` figures |
| `src/drag-controller.js`, `src/canvas-interaction.js`, `src/marquee.js` | Pointer hit-testing and dragging |
| `src/export-utils.js` | GIF and video timing, PNG ZIP packaging |
| `vendor/` | gif.js, bundled so exports work offline |

Projects autosave in the browser that created them. Students can move work between devices with **Save** (downloads a `.json` project file) and **Open**.

## Notes for contributors

- `index.html` has mixed CRLF and LF line endings in the repository. Some editors normalise every line when saving, which makes a small change look like thousands of changed lines. Check `git diff --stat` against `git diff --stat --ignore-cr-at-eol` before committing.
- Per-feature change logs (`*-CHANGE-LOG.md`) and `IMPLEMENTATION_PLAN.md` record what changed and why.
