# Basketball hoop STK compatibility checkpoint

Checkpoint: 2026-09-19. Bounded analysis of the supplied official Pivot Animator
library entry `basketball hoop` (Mr Randomizer, Pivot 5, detail 19). The source
binary and reference image remain outside the repository; no commit or push was
made.

This checkpoint also corrects a defect introduced by the earlier sheep work: the
`a9` importer was letting the per-segment flag hide strokes, which erased most of
the basketball hoop. See "Correction" below.

## Source and measured payload

- Source: `/Users/crayner/Downloads/basketball hoop.812bfc5e.stk`.
- Compressed source: **288 bytes**. SHA-256:
  `64ee47575784bed8df14c8d40d1c8fa0a67281ce5c87ab68818e493e33c35917`.
- Outer wrapper: `0x7a`; the remaining bytes are a valid zlib stream.
- Inflated payload: **437 bytes**, header `a9 10 00` (`a91000`), segment count
  `16`. Detail 19 is `16 segments + 3 polygons`.

## Measured layout

The `a9` payload is the `a8` record order with the per-record type byte
removed. Every segment is one 22-byte record:

```text
parent uint16 | length float32 | angle float64 | width float32 | flag byte | R G B
     +0             +2               +6              +14          +18      +19..21
```

| Section | Offset / size | Measured interpretation |
| --- | ---: | --- |
| Header | `0..2` / 3 bytes | `a9`, then uint16 LE segment count `16` |
| Segment records | `3..354` / 352 bytes | `16 × 22`; all parent references are backward or zero |
| Curve count | `355..356` / 2 bytes | uint16 LE `0` (no curves) |
| Polygon count | `357..358` / 2 bytes | uint16 LE `3` |
| Polygon records | `359..398` / 40 bytes | 3 records: dark base ×2 (3 vertices each) and a light-grey net (5 vertices) |
| Draw ranks | `399..436` / 38 bytes | `19 × 2` uint16 values; 19 is `16 + 3`, a complete permutation |

Accounting is exact: `3 + 352 + 2 + 2 + 40 + 38 = 437` bytes.

Measured flags are `0: 3`, `1: 13`; all types are line `0`. The pole spine
segment 1 and the net spine segment 12 have width `0` and flag `0`; the visible
pole, backboard and base structure are flag `1` segments with width `8.601...`,
and the orange rim is flag `0` with width `8.601...`.

## Defect found and Correction (2026-09-19)

- **Symptom:** the preview rendered only the orange rim, the grey net and the
  dark base triangle. The black pole and backboard were missing.
- **Cause:** the sheep work added an `a9`-only rule that a segment is painted
  only when `flag === 0` (the `visible` field). The hoop's pole/backboard
  strokes are `flag === 1` with positive width, so they were suppressed. The
  `flag` byte does not gate painting in the measured `a8`/`a0` layouts, where a
  segment is painted whenever its width is positive and flag `0` only marks a
  pose control. Giraffe2 (flags `0: 31`, `1: 171`, 32 controls, silhouette IoU
  0.9839 against its reference) is direct evidence for that model.
- **Fix:** `parseV5A9` no longer writes a `visible` field; painting is positive
  width (or a measured circle), independent of flag. The renderer, drag
  controller and bounds code reverted the `segment.visible === false` handling,
  and the import summary again counts `flag === 0` controls.

Accepted changes:

- Corrected the `a9` segment semantics to match the measured `a8`/`a0` layouts:
  flag `0` marks a pose control, positive width paints a stroke.
- Reverted the `a9`-only visibility field and its validation, and the
  renderer/drag-controller/bounds special cases that depended on it.
- Added a real supplied-basketball-hoop decode test and updated the synthetic
  `a9` test to assert that a positive-width flag-1 segment paints and a
  zero-width segment does not.

Refused changes:

- Treating `flag` as visibility for `a9`, or keeping any segment hidden
  regardless of width, because it erases the supplied hoop.
- Filename-specific or model-specific geometry patches, or declaring the hoop
  unsupported.
- Re-reading the `a9` payload as a style/geometry-reordered layout (already
  refused in `SHEEP-STK-CHANGE-LOG.md`).
- Re-introducing a separate control-visibility field.

## Measured results

- Real source decode and metadata validation: **accepted** — 16 segments, 0
  curves, 3 polygons, 19 draw ranks; all 437 payload bytes accounted for.
- Native figure: 17 joints, **4 pose controls** (root plus flag-0 segments 1, 9
  and 12), **11 flag-1 positive-width strokes** painted.
- Painted artwork bounds at origin: `minX=-135.0122569`, `maxX=57.2266575`,
  `minY=-347.7683502`, `maxY=3.6575927`, spanning the full pole and base.
- Browser preview after the correction shows the black pole, backboard arm,
  orange rim, light net and dark base, matching the supplied reference image.
- Focused suite `node --test tests/stk-import.test.mjs`: **17 passing, 0
  failing**. Full Node suite `node --test tests/*.test.mjs`: **21 passing, 0
  failing**. Full browser suite `npx playwright test --workers=1`: **53
  passing, 0 failing** in 17.1 s. `git diff --check` passed.
- Side effect on the supplied sheep: its flag-1 wool-outline strokes now paint,
  which is the faithful Pivot rendering. Control count is unchanged at 21.

## Open limits

- Only the measured `a8`, `a0` and `a9` Pivot 5 payloads are accepted; the
  wrapper/header is not a general Pivot version detector.
- The `flag` byte is treated as the measured control marker only. Its full
  Pivot semantics beyond painting/control are not claimed.
- The source binary was never modified or copied into the repository.
