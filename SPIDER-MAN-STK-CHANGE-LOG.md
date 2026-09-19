# Spider-Man_Eysi STK import — local change log

Checkpoint: 2026-09-19. Bounded support for the supplied Pivot Animator library
entry `Spider-Man_Eysi` (Eysi, Pivot 5, detail 60). The source binary and
reference image remain outside the repository; no commit or push was made for
this checkpoint.

## Reported problem

Importing the file failed with `unsupported Pivot 5 payload header 883c00`. The
importer only accepted the measured `a0`, `a8` and `a9` Pivot 5 headers.

## Source and measured payload

- Source: `/Users/crayner/Downloads/Spider-Man_Eysi.c1dee0f9.stk`.
- Compressed source: **1,230 bytes**. SHA-256:
  `715cff3e27f75c6815c4838a2a608d937d2ad9a881dff4be341e1dc93d1322ca`.
- Outer wrapper: `0x7a`; the remaining bytes are a valid zlib stream.
- Inflated payload: **1,727 bytes**, header `88 3c 00` (`883c00`), segment
  count `60`. Detail 60 is the 60 segment records; there are no polygons.

## Measured layout

The `0x88` payload is the `a8` layout with a uint16 source id inserted after
each parent reference, making each segment record **25 bytes**:

```text
parent uint16 | source id uint16 | length float32 | angle float64 | width float32 | type byte | flag byte | R G B
     +0              +2               +4               +8              +16          +20        +21      +22..24
```

| Section | Offset / size | Measured interpretation |
| --- | ---: | --- |
| Header | `0..2` / 3 bytes | `88`, then uint16 LE segment count `60` |
| Segment records | `3..1502` / 1,500 bytes | `60 × 25`; source ids are unique, parents are source ids |
| Curve count | `1503..1504` / 2 bytes | uint16 LE `10` |
| Curve records | `1505..1604` / 100 bytes | `10 × 10`: uint16 0-based record index plus float64 bend |
| Polygon count | `1605..1606` / 2 bytes | uint16 LE `0` |
| Draw ranks | `1607..1726` / 120 bytes | `60 × 2` uint16 values, a complete permutation |

Accounting is exact: `3 + (60 × 25) + 2 + (10 × 10) + 2 + (60 × 2) = 1,727`
bytes. Measured segment types are `0: 59`, `1: 1` (the head circle); flags are
`0: 15`, `1: 45`; all transparency is implicit `0`.

Source ids are **not** sequential: the record stream is
`1..24, 26, 28, 29, 31..42, 25, 43..60, 30, 38, 27, 36`. Parent references use
source ids and every parent record precedes its child, so no topological
reorder is needed; only the parent field needs remapping to record-order ids.
Curve references are 0-based record indices, matching the measured `a8`/`a9`
convention (the ten curves land on the contiguous black and white web strands).

## Accepted implementation

- `src/stk-import.js` now recognises the measured `0x88` Pivot 5 layout in
  addition to `a0`, `a8` and `a9`.
- `parseV5A8Id` reads 25-byte records, validates unique source ids, backward
  source-id parents, finite geometry, line types and flags, then remaps parents
  to internal record-order ids. Curves keep 0-based record indices. Polygons
  and draw-rank sections reuse the existing V5 handling.
- Metadata validation accepts the `88` payload header. Positive width paints a
  stroke and flag `0` marks a control, consistent with the corrected `a8`/`a9`
  model from `BASKETBALL-HOOP-STK-CHANGE-LOG.md`.
- `tests/stk-import.test.mjs` adds a synthetic `0x88` fixture proving the
  source-id remap and 0-based curve indices, strict rejection tests for forward
  parents, duplicate source ids and truncation, and a real supplied Spider-Man
  decode test.

## Refused / corrected

- Refused treating `0x88` as the 23-byte `a8` layout: that misaligns every
  record after the first. The measured stride is 25 bytes and was confirmed by
  the 14.0-width float recurring every 25 bytes.
- Refused using the file's source ids as internal joint ids; they are
  out of order and are remapped to record order.
- Refused accepting forward parent references or duplicate source ids.
- Refused model-specific geometry patches; no unsupported type, curve or
  polygon bytes are silently dropped.

## Measured results

- Real source decode and metadata validation: **accepted** — 60 segments,
  10 curves, 0 polygons, 60 draw ranks; all 1,727 payload bytes accounted for.
- Native figure: **61 joints**, **16 pose controls** (root plus 15 flag-0
  segments; the flag-1 head circle paints but is not a control).
- Painted artwork bounds at origin: `minX=-23.0228341`, `maxX=28.2588757`,
  `minY=-113.4638187`, `maxY=109.4824381` — a tall, thin standing figure.
- Browser preview renders the red-and-blue Spider-Man with its cream eye,
  curved web strands, blue legs and white soles, matching the supplied
  reference image. Cancel left the project unchanged.
- Focused suite `node --test tests/stk-import.test.mjs`: **20 passing, 0
  failing**. Full Node suite `node --test tests/*.test.mjs`: **24 passing, 0
  failing**. Full browser suite `npx playwright test --workers=1`: **53
  passing, 0 failing** in 16.1 s. `git diff --check` passed.
- The source STK was never modified or copied into the repository.

## Open limits

- The `0x88` sample contains no polygons, so polygon vertex references in this
  layout are not asserted; they are parsed with the existing 0-based V5 node
  convention and would need a measured sample to confirm.
- This release boundary remains the measured Pivot 3/4/5 layouts (`01`, `a0`,
  `a8`, `a9`, `88`); the wrapper/header is not a general Pivot version detector.
