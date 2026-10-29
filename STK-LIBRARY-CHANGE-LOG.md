# Pivot STK library coverage — change log

Checkpoints: 2026-10-28 and 2026-10-29. The importer was tested against every `.stk` figure in the
public [Pivot STK library](https://pivotanimator.net/stk-library/) and extended until **1,073 of its
1,125 figures (95%) import**, up from 379 (34%), including figures of up to 9,000 parts. Figures
that import are also drawn the way their library thumbnails show them.

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
| 5 | 359 / 616 | **565 / 616** |
| **All** | **379 / 1,125** | **1,073 / 1,125** |

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

- **Part cap raised from 512 to 10,000** (see *Very detailed figures* below). Figures over 2,048
  parts show a notice in the import preview.
- **Joint positions in linear time.** `Figure.updatePositions` now indexes children once instead of
  scanning every joint for each joint. A 1,017-part figure went from hundreds of milliseconds to
  17 ms, with a 4× CPU slowdown. The output is identical for every figure.
- **Preview label.** The import preview names Pivot 2 files correctly.

## Very detailed figures (2026-10-29)

The library's largest figures have 5,000 to 9,000 parts (the gigantosaurus is 5,507; Godzilla 8,981).
Drawing and posing them was already fast enough; what made them unusable was **copying**: the app
deep-copied a figure's artwork into every frame, every Undo step and every playback pose, and saved it
again in every frame.

- **Shared, frozen artwork.** Imported artwork is validated, copied and frozen once
  (`settleStkArtwork`), then shared by every clone. Any accidental edit throws instead of silently
  changing every frame, and already-validated artwork skips re-validation when drawn.
- **Project format version 6.** Each artwork is saved once, in `stkArtworks`; frames keep only an
  `stkPose` of `[length, angle]` per joint. A figure whose joints differ from what its artwork implies
  keeps its full joint list, so nothing is lost. Version 5 files still open, and identical embedded
  artworks are shared once loaded. Joint `x`/`y` positions, which are always recalculated, are no
  longer saved.
- **Cheaper Undo.** Stored frames are never edited in place (grouping now replaces the frames it
  changes), so Undo snapshots share them instead of deep-copying every frame.
- **No deep recursion.** Joint positions, limb rotation and artwork bounds no longer recurse or spread
  huge argument lists, either of which overflowed the call stack on figures nested thousands of joints
  deep.

A 21-frame animation of the 5,507-part gigantosaurus, measured with a 4× CPU slowdown:

| | Before | After |
| --- | ---: | ---: |
| Add a frame | 1.0–1.8 s, growing | about 0.5 s |
| Undo snapshot (on every click) | 0.3–0.7 s | 1–3 ms |
| Autosave (after every drag) | 0.3–0.8 s | 0.08–0.23 s |
| Project file | 51 MB (too big to reopen) | 5.6 MB |
| Browser memory | 756 MB | 117 MB |

All 21 newly importing large figures were checked against their thumbnails, and the user's own
`dino.stk` (identical to the library's gigantosaurus) was imported through the real picker, saved and
reloaded. No previously importing figure draws differently.

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

## Still unsupported (52 figures)

| Count | Reason | What it would take |
| ---: | --- | --- |
| 30 | Construction segments longer than 10,000 units | Raise the importer's length limit *and* the project loader's joint-length limit together, or saved projects become unopenable |
| 13 | Segment type 2 (embedded images) or other unknown types | A new feature: image segments |
| 6 | A draw-order table with one duplicate and one missing value | Decide how Pivot orders the clash; left rejected rather than guessed |
| 2 | A curve bend beyond the 1.95π safety bound | Check whether such bends are real |
| 1 | Pivot 3 file with trailing data | Inspect the extra bytes |
