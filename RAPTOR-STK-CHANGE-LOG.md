# Velociraptor STK import — local change log

Checkpoint: 2026-09-10. Luna xhigh built; parent reviewed. Accepted locally
for this model; stopped here for the user's allowance update. No push.

Scope: local-only Pivot 3 support for the supplied
`/Users/crayner/Downloads/Jurassic Park Velociraptor.ab57fea7.stk`. The source
binary is not copied into the repository, committed, pushed or deployed.

## Measurements

- File size: 2,278 bytes. The complete file is a zlib stream beginning `78da`;
  there is no separate wrapper byte to remove before inflation.
- Inflated payload: 3,746 bytes: header `01`, count `156`, then 156 records of
  24 bytes each.
- Record fields: parent byte, source id byte, reserved uint16 `0`, float
  length, double angle, float width, type byte, flag byte, trailing uint16 `0`.
- Source ids are unique `1..156`; 22 records are out of numeric id order, but
  every parent record precedes its child. There are 155 type-0 records and one
  type-1 record (`id 156`, parent `155`); flags are 41 zero and 115 one.

## Accepted

- Added wrapper `0x78` decoding that inflates the complete file and validates
  the measured header, fixed records, source ids, parents, hierarchy, bounds,
  types and flags.
- Remapped source ids to sequential internal record-order ids while retaining
  source draw order. A stable topological fallback preserves draw ranks for
  future V3 files with forward parent records.
- Rendered legacy type-1 circles generically as a midpoint circle whose source
  length is the diameter, with a white interior and black outline using the
  source width as outline thickness. Existing Pivot 4/5 rendering is unchanged.
- Added focused synthetic regressions for zlib-without-wrapper input,
  out-of-order source ids, legacy circles, and topological draw-rank fallback.
- Updated `index.html`'s detected-version label, `src/drag-controller.js`'s
  circle classification, and `src/stk-renderer.js`'s circle rendering/bounds.

## Refused / corrected

- Refused treating `0x78` as an extra wrapper and inflating from byte 1; that
  drops the zlib header and rejects the supplied file.
- Refused assuming source ids are already sequential; the supplied file has
  out-of-order ids even though its parent records are ordered.
- Refused hardcoding a character-specific full white disk for type 1. The
  measured legacy hollow-circle construction keeps the black outline and
  white interior independent of the Velociraptor name.

## Local checks

- `node --test tests/stk-import.test.mjs`: **8 passing, 0 failing**.
- Direct decode of the supplied file: wrapper `0x78`, 156 segments, 157 native
  joints, identity draw ranks after source-id remapping, one type-1 circle;
  no source-data mutation.
- Parent retrieved the official model-page preview because the supplied
  temporary screenshot had expired. Restored stopped local server on 4175;
  initial review failures were missing reference/server, not import failures.
- Official preview versus native render: normalized black silhouette IoU
  **0.978090**, bounding-box aspect difference **0.6964%**. This is a
  silhouette comparison, not a claim of pixel-perfect or universal support.
- All **42** visible controls passed real pointer posing checks; maximum
  rigid-descendant error **1.798e-13** document units. Double-flip angle
  error **8.327e-16**; smoothed t=1 matched the target frame pixel-for-pixel.
- Actual import and browser save/reopen retained **157 joints** and V3
  metadata; **zero page errors**. Render visually reviewed against reference.
- Final `node --test tests/*.test.mjs`: **12/12 passed**. One full
  `npx playwright test --workers=1`: **52/52 passed, 15.8 seconds**.
- `git diff --check`: passed. Review image and script are under
  `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/`:
  `raptor-import-reviewed.png`, `review-raptor.mjs`. Posing reused
  `review-stk-controls.mjs` with only the fixture list changed in memory.
