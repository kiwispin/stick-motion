# Sheep cartoon STK compatibility checkpoint

Checkpoint: 2026-09-19 (corrected). This is a bounded analysis of the supplied
official Pivot Animator library entry `sheep cartoon` (Peter Bone, Pivot 5,
detail 370). No source binary is copied into the repository. No commit or push
was made.

This version supersedes the 2026-09-16 checkpoint. That earlier record claimed
an `a9` "reordered style/geometry" layout and concluded the sheep exposed only
3 controls. Both claims were wrong: the layout was grouped incorrectly and
shifted every segment's style by one record. The correction is recorded under
"Correction" below.

## Source and measured payload

- Source: `/Users/crayner/Downloads/sheep cartoon.440d9893 (1).stk`.
- Compressed source: **7,252 bytes**. SHA-256:
  `ac5c8c1f4167767194d1dab6c0f041f7d04fd705cd47e0002be8a10199794bae`.
- Outer wrapper: `0x7a`; the remaining bytes are a valid zlib stream.
- Inflated payload: **11,383 bytes**. Payload header is `a9 56 01`.
- The little-endian word at payload offset 1 is **342**, the total segment
  count.

## Corrected binary accounting

All offsets below are payload offsets. The `a9` payload is the `a8` record
order with the per-record type byte removed. Every segment is one **22-byte**
record:

```text
parent uint16 | length float32 | angle float64 | width float32 | flag byte | R G B
     +0             +2               +6              +14          +18      +19..21
```

| Section | Offset / size | Measured interpretation |
| --- | ---: | --- |
| Header | `0..2` / 3 bytes | `a9`, then uint16 LE segment count `342` |
| Segment records | `3..7526` / 7,524 bytes | `342 × 22`; all parent references are backward or zero, all widths finite |
| Curve count | `7527..7528` / 2 bytes | uint16 LE `243` |
| Curve records | `7529..9958` / 2,430 bytes | `243 × 10`, each uint16 segment reference plus float64 bend |
| Polygon count | `9959..9960` / 2 bytes | uint16 LE `28` |
| Polygon records | `9961..10642` / 682 bytes | 28 records: uint16 vertex count, RGB bytes, one zero byte, and vertex references |
| Draw ranks | `10643..11382` / 740 bytes | `370 × 2` uint16 values; 370 is `342 + 28`, a complete permutation |

The accounting is exact: `3 + (342 × 22) + 2 + (243 × 10) + 2 + 682 + (370 × 2)
= 11,383` bytes. The first record has parent `0` (it is the root segment); the
previous checkpoint misread those two bytes as opaque `a9RootFields`.

## Style-prefix mapping

Each record's style is `width` float32 at `+14`, one-byte `flag` at `+18`, and
RGB bytes at `+19..21`. Distinct measured styles:

```text
width 0       flag 0  black          (18 segments)
width 0       flag 1  black          (270 segments)
width 2.125   flag 1  rgb 230,205,183  (48 segments)
width 1.590.. flag 0  rgb 221,106,40   (2 segments)
width 14.125  flag 1  white          (2 segments)
width 15.75   flag 1  rgb 224,147,60   (2 segments)
```

The two bytes previously retained as `a9RootFields` are simply the first
segment's parent. The earlier error grouped the section as a leading 14-byte
geometry record plus 341 `[style][geometry]` records plus a trailing style, which
reassigned every style to the preceding segment and the last style to the root.
Geometry never moved, so the silhouette looked plausible and the mistake went
unnoticed, but widths, flags and colours were rotated by one segment.

## Correction (2026-09-19)

- **Root cause:** `parseV5A9` read the first style at payload offset 17 (the
  style of segment 1) and labelled it segment 2's style, then continued a
  22-byte stride. Every segment therefore inherited the previous segment's
  width/flag/colour, and the trailing style was applied to segment 1.
- **Fix:** `parseV5A9` now reads `342` uniform 22-byte records in `a8` order
  without the type byte, so each segment keeps its own style. `a9RootFields`
  and the `controlVisible` field were removed; `parent` is read directly and
  segment 1 is validated against the same backward-parent rule as the rest.
- **Control semantics:** flag `0` marks the figure's controls, matching the
  measured `a8`/`a0` layouts already validated for Owl, Chill, Giraffe2,
  Velociraptor and the football. The previous checkpoint's extra
  `width > 0` restriction was wrong: flag-0 segments are controls whether or
  not they have a painted stroke.
- **Painting semantics (corrected again on 2026-09-19 by the basketball hoop
  checkpoint):** the flag byte does not gate painting. A segment is painted
  whenever its width is positive. The first correction kept flag-1 paths
  unpainted, which erased the supplied basketball hoop's pole and backboard;
  that rule was removed. The sheep's flag-1 wool-outline strokes therefore now
  paint, which is the faithful Pivot rendering. See
  `BASKETBALL-HOOP-STK-CHANGE-LOG.md`.
- **Effect:** the sheep now exposes **21 pose controls** (root plus 20 flag-0
  skeleton segments), including the main root segment `stk-1` (277 descendants)
  and leg/head/tail controls. It was effectively un-poseable when only two leaf
  segments were exposed.

Accepted modifications:

- Fixed the generic strict `a9` decoder in `src/stk-import.js`.
- Preserved every measured width/flag/RGB style, parent, length and angle, plus
  all curves, polygons and the complete draw-rank permutation.
- Paint positive-width segments independent of flag, and use flag `0` only as
  the control marker, matching the `a8`/`a0` layouts.
- Added synthetic layout/rejection tests and a real supplied-sheep decode test.
- Updated the import summary to count flag-0 controls directly.

Explicitly refused:

- Treating `a9` as a prefix/style-reordered variant of `a8`, or retaining
  `a9RootFields`, or shifting record boundaries.
- Requiring positive width before a flag-0 segment is exposed as a control.
- Inventing semantics beyond the measured record order or introducing
  filename-specific handling.
- Mutating source widths or dropping hidden nodes required by polygon
  boundaries.

## Verification

- The supplied payload decodes to 342 segments, 243 curves, 28 polygons and
  370 draw ranks, with 322 flag-1 paths and 20 flag-0 controls.
- Post-mapping artwork bounds at origin remain `minX=-164.5848063`,
  `maxX=33.2190790`, `minY=-127.2361580`, `maxY=75.5146570`. The earlier
  "beige construction diagonal" was created by the misaligned parse; it does
  not appear with the corrected layout.
- Browser review with the corrected module: preview reports **21 pose
  controls**; inserted sheep exposes face, neck, body, leg and tail handles and
  deforms correctly when a leg control is posed. Positive-width flag-1 wool
  outlines paint, matching the measured `a8`/`a0` model.
- Focused suite **17/17** (`node --test tests/stk-import.test.mjs`), full Node
  suite **21/21** (`node --test tests/*.test.mjs`), and the full browser suite
  **53/53** (`npx playwright test --workers=1`). `git diff --check` passed.
- No source binary was copied into the repository; no commit or push was made.
