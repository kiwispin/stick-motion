# Soccer ball STK checkpoint — 2026-09-12

## Release authorization — 2026-09-12

User approved pushing this reviewed fix live. Remote main was fetched and
confirmed aligned before committing. Release includes the retained Giraffe2
compatibility log; no additional application changes or model work were added.
Earlier no-push statements below describe the pre-release checkpoint.

Scope: bounded compatibility checkpoint for the supplied Pivot STK Library
object “Soccer ball - Football”, creator Peter Bone, Pivot 5, detail 60. The
source STK and reference GIF remain external and read-only. The unrelated
untracked `GIRAFFE2-STK-CHANGE-LOG.md` was preserved. No commit, push,
deployment, broad refactor or new model type was made.

## Source evidence

- STK source: `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/Soccer ball - Football.9afa34cd.stk`
- SHA-256: `2bca1668a4808ec01ad459aeb797c662b069d378a464e39930fd63e9fa9de513`
- Compressed source: 1,306 bytes; outer wrapper `0x7a`; bounded zlib
  inflation: 1,827 bytes.
- Inner payload header: `a0 34 00` (`a03400`), not the previously accepted
  `a8` header.
- Reference: `football-reference.gif`, 400×400 animated GIF; first frame was
  inspected separately by the parent review.

## Measured payload layout

The header-only `a0`→`a8` alias was refused: parsing the source as the 23-byte
`a8` layout misaligned segment 2 and produced a forward/unknown parent. A
stride search over the complete decompressed payload found the following
strictly accounted-for layout:

| Section | Measured bytes | Interpretation |
| --- | ---: | --- |
| Header | 3 | `a0` + little-endian segment count 52 |
| Segment records | 1,248 | 52 × 24 bytes: parent `uint16`, length `float32`, angle `float64`, width `float32`, type byte, flag byte, RGB bytes, transparency byte |
| Curve section | 322 | Count 32 + 32 × (segment index `uint16` + bend `float64`) |
| Polygon section | 134 | Count 8 + eight 6-byte headers plus 42 little-endian vertex references |
| Draw ranks | 120 | 60 × `uint16`, an exact permutation for 52 segments + 8 polygons |

The segment records have types 0×50 and 3×2, flags 0×2 and 1×50, and valid
parent references for all 52 records. Transparency values are 0 for 51
segments and 159 for the white highlight circle. Polygon transparency values
are 0 for seven polygons and 198 for the black shadow polygon. The measured
inverse-transparency interpretation is retained as an evidence-backed
hypothesis: effective canvas alpha is `(255 - transparency) / 255`. The
reference contrast supports this mapping, but exact Pivot semantics remain an
experimental limit pending parent pixel comparison.

## Accepted implementation

- `src/stk-import.js` now recognizes exactly the measured `a0` Pivot 5 payload
  layout in addition to the existing `a8` layout. It uses a 24-byte record
  stride only for `a0`, keeps the extra byte as integer `transparency`, and
  treats the polygon header’s final byte as transparency in this layout. The
  old `a8` polygon reserved-byte validation remains in force.
- STK metadata validation accepts only `a0` or `a8` V5 payload headers, checks
  transparency as an integer from 0 through 255, requires the byte in `a0`
  records, and rejects nonzero transparency attached to older/`a8` layouts.
- `src/stk-renderer.js` applies each retained transparency multiplicatively to
  the incoming `context.globalAlpha`, preserving onion-skin/figure fades and
  Canvas save/restore behavior. Fully transparent items are omitted from fit
  bounds, except that a fully transparent curved segment is retained without
  stroke padding when it forms the boundary of an opaque polygon.
- `tests/stk-import.test.mjs` adds a synthetic complete `a0` fixture, a
  transparent curved-polygon bounds regression, and strict missing,
  non-integer, out-of-range, truncated, unknown-header and `a8` mismatch
  assertions.

## Measured results

- Real source decode and metadata validation: **accepted** — 52 segments, 32
  curves, 8 polygons, 60 draw ranks; all decompressed bytes accounted for.
- Focused unit suite: `node --test tests/stk-import.test.mjs` — **13 passing,
  0 failing** after the final strict-validation tests were added.
- Full local Node suite: `node --test tests/*.test.mjs` — **17 passing, 0
  failing** (195.31 ms).
- Parent functional review: **accepted** — the real source inserted with 53
  native joints and 3 controls; Cancel preserved the project exactly; save /
  reopen preserved metadata exactly; zero JavaScript page errors occurred.
- Parent first-frame review via `ImageDecoder`: normalized silhouette IoU
  `0.993187956941551`, aspect-ratio error `0.0007293320176755547` (0.0729332%),
  and RGB-overlap error `2.284016684345267 / 255`. Reference painted bounds
  were `(x=37, y=37, width=327, height=326)` and rendered bounds
  `(x=186, y=36, width=429, height=428)` after the app's uniform fit.
- Parent posing/export review: all 3 controls passed, maximum rigid-branch
  error `2.3437142008433856e-13`; smoothing at `t=1` changed zero channels;
  double-flip angle error was `8.881784197001252e-16`. The reviewed output is
  `football-import-reviewed.png` in the external visualization directory.
- Parent browser regression: `npx playwright test --workers=1` — **52
  passing, 0 failing** in 15.9 s (the final code state; the added Node-only
  strict assertions do not alter browser test count).
- The source STK was never modified. No old rejected attempt was repeated.

## Refused / open limits

- Refused treating `a0` as a header-only alias for `a8`; its 24-byte records
  and transparency-bearing polygon headers are materially different.
- Refused accepting unknown inner headers or discarding the extra byte.
- An initial bounds change that unconditionally skipped fully transparent
  segments was refused after identifying that such a segment can define an
  opaque polygon's curved edge. The accepted fix retains only that path's
  extrema with zero stroke padding; the final source has no fully transparent
  segment, and the focused regression covers the case.
- Exact alpha semantics and pixel-level fidelity are **not yet claimed**; the
  measured first-frame review strongly supports the inverse-transparency
  mapping, while Pivot's internal naming remains undocumented.
