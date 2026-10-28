# Pivot STK library coverage — change log

Checkpoint: 2026-10-28. The importer was tested against every `.stk` figure in the public
[Pivot STK library](https://pivotanimator.net/stk-library/) and extended until **1,052 of its
1,125 figures (94%) import**, up from 379 (34%). Figures that import are also drawn the way their
library thumbnails show them.

## Test set and harness

- **Test set.** All 1,125 library `.stk` files (4.7 MB), downloaded once, politely, on 2026-10-28,
  are kept in `stk/library/` with a `catalogue.json` (name, creator, category, Pivot version,
  thumbnail URL). They are other people's work, so `stk/` is git-ignored and never published.
- **Harness.** `npm run test:stk-corpus` (`tests/stk-corpus.mjs`) runs every figure through the
  importer, renderer and project loader. It reports coverage by Pivot version, and fingerprints each
  figure's decoded data and drawing calls against `stk/library/baseline.json`. Any change shows up as
  newly importing, **regressed**, or changed output. `--save-baseline` records a new reference, and
  `--list=changed` names the affected figures.
- **Visual check.** Every figure whose output changed, and every newly importing figure, was drawn
  with the app's renderer next to its library thumbnail and checked by eye.

| Pivot version | Before | After |
| --- | ---: | ---: |
| 2 | 0 / 448 | **448 / 448** |
| 3 | 19 / 20 | 19 / 20 |
| 4 | 1 / 41 | **41 / 41** |
| 5 | 359 / 616 | **544 / 616** |
| **All** | **379 / 1,125** | **1,052 / 1,125** |

## Format findings

### Pivot 2, 3 and 4 share one 24-byte record

```text
parent source id u8 | source id u8 | pad u16 | length f32 | angle f64 | width f32 | type u8 | flag u8 | pad u16
```

- **Pivot 3** wraps `[01][count u8][records]` in zlib and zero-fills both padding fields; it keeps its
  strict padding check.
- **Pivot 2** is the same payload *uncompressed*: the file starts with `0x01`, which cannot begin a
  zlib stream. Its padding is uninitialised memory (every record in a file repeats the same leftover
  bytes), so it is kept for round trips but not checked.
- **Pivot 4** is the record without the `01` header byte, wrapped as `0x79` + zlib. Its padding values
  vary from file to file (0, 3133, 6450, …); the importer previously insisted on 3133, the value in its
  one sample, and so rejected 40 of 41 library files.
- **Shared by all three:** parents reference source ids, which need not be in order, so segments are
  remapped to record order (with a stable topological order if a parent comes later). Flag 1 marks a
  construction segment, which has no pose handle.

### Pivot 5's header byte is a bit field

Each set bit removes one field from every segment record, and the reader restores its default:

| Bit | When set |
| --- | --- |
| `0x01` | no type byte: every segment is a line |
| `0x02` | no flag byte: every segment is a pose control |
| `0x04` | no RGB: every segment is black |
| `0x08` | no segment transparency |
| `0x10` | no draw-rank table: draw in record order (only seen without polygons) |
| `0x20` | no source ids: ids follow record order |
| `0x40` | adds an 8-byte figure-outline trailer after the draw ranks: `[thickness f32][RGB][transparency]` |
| `0x80` | no gradient marker; when clear, each record ends with `0`, or `1` + end RGB + transparency |

- **Coverage.** All 42 header values in the library parse to the exact byte under this table. The
  previously supported `a8`, `a0`, `a9` and `88` are just four combinations.
- **Polygons.** The sixth byte of every polygon header is its transparency, in every layout.
- **Source ids.** When source ids are present, polygon vertices name nodes by source id, like parents
  do, and are remapped. Curve references are always record indices. Reading the vertices by record
  order caused the fan artefacts on the library raptors' tails and a scrambled Big Chungus.

### Circle types, measured against thumbnails

| Type | Pivot | Drawn as |
| --- | --- | --- |
| 1 | 2, 3, 4, 5 | a white-interior circle outlined in the segment colour |
| 3 | 4, 5 | a solid disc |
| 4 | 4, 5 | a hollow ring stroked at the segment width, e.g. a tyre around its rim |

- **Diameter.** Each circle's diameter is the segment chord.
- **Zero width.** Only a solid disc paints at zero width. Zero-width outlined circles are
  invisible.
- **What type 4 fixes.** Type 4 was drawn as a round-capped stroke before, which turned every tyre
  into a bar.

## Other changes

- **Part cap raised from 512 to 1,024.** Very detailed figures save about 400 KB per frame per 1,000
  parts, so a higher cap would let a student save a project too large (over 25 MB) to reopen. Figures
  over 512 parts show a notice in the import preview.
- **Joint positions in linear time.** `Figure.updatePositions` now indexes children once instead of
  scanning every joint for each joint. A 1,017-part figure went from hundreds of milliseconds to
  17 ms, with a 4× CPU slowdown. The output is identical for every figure.
- **Preview label.** The import preview names Pivot 2 files correctly.

## Verification

- **Regressions.** None. The only previously importing figures whose output changed were the 74 that
  the circle and source-id fixes were meant to change, and the Pivot 4 Stick Man (Chill Edition),
  whose metadata gained source-id fields while its drawing stayed identical.
- **Malformed files.** About 19,000 corrupted Pivot 2 inputs and 25,256 corrupted Pivot 5 inputs (byte
  flips, truncations, every kind of header value, trailing data) were all either imported, drawing with
  finite numbers, or cleanly rejected with an `STK import rejected:` message. None crashed.
- **Tests.** 49 unit tests, including real-figure tests for every Pivot version, and 69 browser tests
  pass.
- **In the app.** Six figures, one from each new family, were imported through the editor's real
  Import STK picker. Each saved, survived a reload, and caused no page errors.

## Still unsupported (73 figures)

| Count | Reason | What it would take |
| ---: | --- | --- |
| 27 | Construction segments longer than 10,000 units | Raise the importer's length limit *and* the project loader's joint-length limit together, or saved projects become unopenable |
| 25 | More than 1,024 parts | Store imported artwork once per project rather than per frame, then raise the cap |
| 13 | Segment type 2 (embedded images) or other unknown types | A new feature: image segments |
| 6 | A draw-order table with one duplicate and one missing value | Decide how Pivot orders the clash; left rejected rather than guessed |
| 1 | Pivot 3 file with trailing data | Inspect the extra bytes |
| 1 | A curve bend beyond the 1.95π safety bound | Check whether such bends are real |
