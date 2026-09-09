# STK import — experimental change log

## Release authorization — 2026-09-09

The user approved publishing this importer together with the autosave recovery
fix. The later recovery work resolves the historical failing-test caveat below;
the combined release passed 52/52 browser tests and 10/10 unit tests. See
`AUTOSAVE-RECOVERY-CHANGE-LOG.md`. Earlier local-only notes record the review
stage, before this release authorization.

Scope: local implementation of a preview-first Pivot STK importer for
StickMotion. The supplied `.stk` files remain outside this repository and are
read-only. No source artwork is copied into the repository; tests construct
synthetic binary fixtures.

Builder: Luna, xhigh. Reviewer: parent agent. Final local implementation is
accepted for experimental user testing; nothing was committed, pushed or deployed.
The reviewer finalized and deduplicated this review record after the build.

## 2026-09-09 — implementation and review record

### Accepted implementation

- Added `src/stk-import.js`, with bounded browser `DecompressionStream` deflate
  decoding, file-size/decompressed-size/count limits, complete-layout checks,
  parent/id/cycle-safe validation, colors, flags, curves, polygons and
  rank-per-item draw-order preservation.
- The tested Pivot 4 wrapper (`0x79`, 24-byte records) accepts line/type-3
  circle records only and requires the observed reserved/trailing layout.
- The tested Pivot 5 wrapper (`0x7a`, `a8 + uint16 segment count`) accepts
  type-0 lines and type-4 records. Type 4 is intentionally rendered with an
  explicit round-cap approximation. Type 5/6, gradients and unknown flags are
  rejected; unsupported bytes are not silently dropped.
- Added source-artwork metadata to `Figure.clone()` in `src/models.js` and
  validated/bound metadata to native `stk-root`/`stk-N` joints in
  `src/project.js`. Imported figures may use a bounded 513-joint limit
  (root + 512 segments); ordinary figures remain capped at 100 joints.
- Added `src/stk-renderer.js` for native canvas arc paths, measured Pivot 4
  filled-circle mapping, polygon edges that follow adjacent curved segments,
  interleaved draw ranks and imported pose handles. Existing figures continue
  through the original renderer path.
- Added a top-bar and compact-menu “Import STK” action, an
  “Import STK — Experimental” warning, asynchronous preview, explicit Insert
  confirmation and Cancel/Error paths in `index.html`. Parsing and preview do
  not call `saveState` or mutate project frames. New/Open invalidates stale
  requests; insertion snapshots history and adds to only the current frame.
- Imported figures are uniformly fitted to the document artwork envelope while
  retaining native source lengths/angles/curve data. This keeps the visible
  preview inside the stage while retaining offstage construction nodes.
- Flip negates imported signed bends; interpolation and all existing PNG/GIF/
  WebM/ZIP export paths retain cloned artwork metadata and use the same native
  canvas renderer.
- Follow-up correction: Flip also updates the mirrored curve parameter records
  so strict metadata validation continues to pass. Interpolation carries bend
  metadata from A→B (and uses an exact B clone at `t=1`).
- Added synthetic unit tests in `tests/stk-import.test.mjs` covering both
  layouts, negative arcs, colors/flags/polygons/ranks, bounded 101-joint
  import, malformed/trailing/type rejection and metadata/native-joint binding.
- Added `tests/e2e/stk-import.spec.js`: two permanent synthetic-file browser
  regressions for preview, Cancel, Insert, undo/redo, recovery and rejection.
- Accepted final safety/UI corrections: require explicit polygon arrays in
  saved metadata; reject artwork that cannot fit at the minimum supported
  scale; include zero-width filled circles in bounds using their true centre
  and radius; preserve preview aspect ratio; scroll short-screen dialogs.

### Measured results

- Local decoder smoke test: Chill sample `0x79`, 16 segments, one type-3
  circle, 17 native joints; Duolingo sample `0x7a`, 100 segments, 62 curves,
  17 polygons, 101 native joints; airplane sample rejected at type 6.
- `node --test tests/stk-import.test.mjs` (2026-09-09): **6 passing, 0
  failing**, including pre-read file-size and decompression-bomb limits.
- Corrected signed-arc geometry: negative-quarter-arc t=0 returns its start;
  t=1 and all positive/negative curved endpoints join native chord endpoints
  within approximately `5.4e-13` document units on the Owl fixture.
- Parent-side real UI review (existing local server): preview + Cancel left
  the project byte-for-byte unchanged; Owl inserted into active frame with its
  other frame/native figure preserved; 101 joints and 17 polygons survived
  save/reopen; airplane type-6 rejection and Escape cancellation worked;
  Chill inserted alongside Owl; page errors were zero.
- Independent local visual smoke check: Owl rendered as a centered, layered
  green figure with white eyes, colored beak/feet, 100 segments and 17 filled
  polygons; Chill rendered with its measured filled head circle and visible
  pivots. No page errors occurred.
- Interim standalone Node suite: **8 passing, 0 failing**, before the sixth
  STK test was added. Separately, an interim browser run reported **48 passing,
  1 failing** on an existing startup/recovery test. These were separate runs,
  not a combined suite.
- Final independent `npx playwright test --workers=1`: **50 passing, 1 failing,
  20.6 seconds**. Both new STK tests passed. The failure was the previously
  observed `tests/e2e/editor.spec.js:35` name-recovery test: expected
  `Rocket rehearsal`, received `Untitled animation`. No existing test was
  weakened or unrelated recovery behavior changed. The full suite is NOT green.
- Parent-side native renderer regression review (2026-09-09): all 30
  pre-integration PNG hashes (15 models × default/recolored-scaled-rotated)
  remained exact after the imported-artwork branch was added.
- Parent-side durable pointer review (2026-09-09): all 27 tested controls (Owl
  10 and Chill 17) selected and posed correctly after recentering; rigid
  descendant maximum errors were `6.629e-13` (Owl) and `1.729e-13` (Chill).
  Double-flip angle errors were at most `8.89e-16`; smoothed `t=1` output was
  pixel-identical to the flipped target frame. An initial subpixel pointer
  exactness assertion was refused as overstrict and replaced with actual
  picked-joint rotation measurement.
- Parent-side cancellation-race review (2026-09-09): Cancel, New and the real
  Open-project workflow all invalidated a deferred decode; releasing the
  pending `arrayBuffer()` promise left no modal/pending insert and the exact
  post-action project JSON unchanged.
- Preview layout review (2026-09-09): the import canvas keeps its 596:240
  aspect ratio at 1500, 1024 and 560 px viewports; the earlier CSS max-width
  override that horizontally squashed Owl preview was corrected.
- Focused browser regression `npx playwright test
  tests/e2e/stk-import.spec.js --workers=1` (2026-09-09): **2 passing, 0
  failing**. Synthetic STK preview Cancel was non-mutating; confirmed insert
  was additive, undoable and save/reopen durable; unsupported type failure left
  the project unchanged and Escape closed the preview.
- `node --test tests/*.test.mjs` (2026-09-09): **9 passing, 0 failing**.
- Export verification (2026-09-09, imported Owl, two *identical* source frames
  with smoothing): PNG frame downloaded as 800×500 with 103,896 non-white RGB
  pixels; PNG ZIP contained 10 interpolated PNGs and first/last members decoded
  as 800×500 with 103,896 non-white pixels; GIF decoded as 800×500 with 8
  frames and non-white first/last frames; WebM downloaded and re-opened in
  Chromium with readyState 4, 800×500 video and currentTime advancing above
  zero. Page errors were zero. Distinct-pose interpolation is covered by the
  pointer review's flipped-target `t=1` pixel check above. These export smoke
  results do not establish timing or final-pose fidelity for long STK projects.
- Short-viewport follow-up (2026-09-09): scoped import modal max-height and
  scrolling keep its Insert/Cancel controls reachable at 1500×1000, 1024×600
  and 560×800; preview sizing now uses the canvas intrinsic aspect ratio.
- Final independent 1024×500 viewport check: modal top/bottom were 16/484 px;
  scroll height 641 px versus client height 466 px; scrolled Insert button
  top/bottom 428.56/458.56 px. Preview content aspect was 2.483399 versus
  intrinsic 2.483333 (layout rounding only).
- Final `git diff --check`: passed. Real-file UI review rerun: all seven
  checks passed, zero page errors. Saved/reopened geometry differed only by
  existing angle normalization roundoff of at most `2.22e-16` radians.

### Refused/corrected approaches (do not repeat)

- Refused direct replacement of the project/current frame during file parse;
  importer remains additive and confirmation-gated.
- Refused silent simplification of type 5/6/gradients, unknown flags, malformed
  parents, duplicate curves/ids, invalid polygon references or draw ranks.
- Refused an unbounded increase of the ordinary 100-joint limit; only Figures
  carrying validated STK metadata receive the bounded extension.
- Refused raw source-angle rendering for curved imported segments after posing;
  arcs now derive current chord direction and preserve signed bend. A negative
  bend radial-start bug and a straight posed-chord bug were found in review and
  corrected. Collapsed interpolation chords now collapse their arc path rather
  than drawing a detached fallback arc.
- Refused the initial fit translation to `(docWidth, docHeight)`; it placed
  painted art at bottom-right. Corrected to document centre and verified Owl
  painted bounds around x=`193.872..606.128`, y=`36..464` in an 800×500 doc.
- Refused loading oversized File/Blob data before checking `.size`; the size
  check now runs before `arrayBuffer()` and remains checked after reading.
- Refused silently clipping oversized supported artwork at the minimum scale;
  such an import now fails before insertion. Refused missing/null polygon
  metadata that passed validation but could fail during rendering.
- Refused double-scaling circle radii and diameter-based oversized circle
  bounds; accepted current-chord radius and exact midpoint/radius bounds.
- Refused a horizontally squashed preview and unscrollable short-screen modal;
  accepted intrinsic canvas sizing and scoped dialog scrolling.
- Refused hit-testing zero-width construction segments; imported construction
  endpoints are skipped by `src/drag-controller.js` while retained in the rig.
- Refined that rule after review: explicitly visible zero-width endpoint
  controls (Owl flag 0) remain pickable, while hidden zero-width construction
  lines remain excluded from body/fallback hit-testing.
- Refused trusting only metadata counts for persisted imported figures; project
  rehydration now binds every `stk-N` native joint to its exact source parent
  and rejects missing/reordered/mismatched joints before rendering.
- Refused claiming type-4 cap semantics are solved: independent round/square
  comparison was effectively inconclusive while butt caps were worse for pupil
  agreement, so the UI keeps the explicit approximation warning.
- Reviewer diagnostics corrected without application changes: exact floating
  angle equality after reopen was too strict; pointer rotation must use actual
  browser coordinates rather than requested subpixels; cancellation tests must
  exercise the real Open workflow, not its internal apply-data helper.

### Independent review artifacts

Review scripts and screenshots are outside the repository in
`/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/`:
`review-stk-app.mjs`, `review-stk-controls.mjs`,
`review-stk-cancellation.mjs`, `review-stk-native-regressions.mjs`,
`stk-native-baseline.json`, `stk-import-preview-reviewed.png`, and
`stk-import-in-app-reviewed.png`. Their source samples remain external.

### Open experimental limits

- This release boundary is the two tested layouts/samples only. The STK
  wrapper/header is not presented as a general Pivot version detector.
- Pivot 4 circle mapping and Pivot 5 type-4 cap semantics are measured
  approximations, not claims of bit-exact compatibility.
- Existing StickMotion has four exports (PNG frame, PNG ZIP, GIF and WebM);
  no SVG exporter was added as part of this work.
- No older physical Chromebook was tested. Source rig controls are preserved;
  some can be far offstage, as in the Owl source file. Unsupported airplane
  features remain rejected. Imported multicolour artwork retains its source
  palette; this work does not add a source-palette editor.
