# Mr G Walking Animation Tutorial Guy With Colors STK checkpoint

Checkpoint: 2026-09-19. Bounded compatibility check of the supplied official
Pivot Animator library entry
`Mr G Walking Animation Tutorial Guy With Colors` (Mr Guiles, Pivot 5, detail
12). The source binary and reference image remain outside the repository; no
commit or push was made for this checkpoint.

## Source and measured payload

- Source:
  `/Users/crayner/Downloads/Mr G Walking Animation Tutorial Guy With Colors.b5338804.stk`.
- Size: **215 bytes**. SHA-256:
  `39ed98463867333bef8737dad96ee81ba365cf572a91e647acfbcba85357d079`.
- Wrapper byte: `0x7a`; the remaining bytes are a valid zlib stream.
- Inflated payload: **307 bytes**, header `a8 0c 00` (`a80c00`) — the measured
  `a8` Pivot 5 layout with segment count `12`.

## Measured layout

| Section | Offset / size | Measured interpretation |
| --- | ---: | --- |
| Header | `0..2` / 3 bytes | `a8`, then uint16 LE segment count `12` |
| Segment records | `3..278` / 276 bytes | `12 × 23`: parent `uint16`, length `float32`, angle `float64`, width `float32`, type byte, flag byte, RGB bytes |
| Curve count | `279..280` / 2 bytes | uint16 LE `0` (no curves) |
| Polygon count | `281..282` / 2 bytes | uint16 LE `0` (no polygons) |
| Draw ranks | `283..306` / 24 bytes | `12 × 2` uint16 values, a complete permutation |

Accounting is exact: `3 + (12 × 23) + 2 + 2 + (12 × 2) = 307` bytes. Detail 12
is the 12 segment records; there are no curves or polygons.

Measured segment set: 11 type-0 lines and one type-1 circle (segment 4, the
head, width `20`, flag `1`); 11 flag-0 controls and one flag-1 circle. Every
parent reference is backward or zero. Colours span maroon torso (`128,64,64`
and `96,48,48`), tan limbs/head (`178,150,150`, `189,165,165`), and blue legs
(`10,56,102`, `17,107,191`). All transparency bytes are `0`.

## Compatibility decision

- **Accepted:** existing `a8` importer behaviour, with no application change.
  `decodeStkBytes` accepts and fully validates the payload, and
  `createFigureFromStk` creates 13 native joints (root plus 12 segments) with
  12 pose controls, preserving hierarchy, widths, flags and colours.
- **No code change:** no parser, renderer, control, persistence or export
  defect was found. The one type-1 circle is handled by the existing generic
  V5 circle mapping and carries its existing warning.
- **Refused:** character-specific geometry patches, type-enum changes, or
  broad STK support expansion without a failing measured case. The source file
  was not copied into the repository.

This follows the same outcome as the Giraffe2 checkpoint, which recorded an
accepted `a8` sample without application changes.

## Verification

- Real source decode and metadata validation: **accepted** — 12 segments,
  0 curves, 0 polygons, 12 draw ranks; all 307 payload bytes accounted for.
- Native figure: **13 joints**, **12 pose controls** (root plus 11 flag-0
  segments; the flag-1 head circle is painted but is not a control).
- Painted artwork bounds at origin: `minX=-42.7390946`, `maxX=56.3635031`,
  `minY=-106.9894471`, `maxY=104.0255279`.
- Browser preview renders the walking figure with its brown head, maroon torso,
  tan arms and blue legs, matching the supplied reference image. Cancel left
  the project unchanged.
- The existing repository suites are unaffected because no application code
  changed: `node --test tests/*.test.mjs` **21/21** and
  `npx playwright test --workers=1` **53/53** at the pushed commit `4bad248`.
  `git diff --check` passed.

## Open limits

- This release boundary remains the measured Pivot 3/4/5 layouts (`01`, `a0`,
  `a8`, `a9`); the wrapper/header is not a general Pivot version detector.
- V5 type-1/type-3 circle fill semantics remain an explicit approximation
  carried by the importer warning.
