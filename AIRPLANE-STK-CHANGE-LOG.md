# TC-KAAN airplane STK compatibility assessment

## Release authorization — 2026-09-10

User approved publishing this reviewed checkpoint together with the Velociraptor
support. Remote main was fetched and confirmed aligned before committing.
No additional model work is included; experimental warnings remain enabled.

Latest status: accepted locally as an **experimental import**, following the
continuation and parent review below. Earlier refusals are retained as history.

Final parent verification: 14/14 unit tests passed (186.36 ms); the full browser
suite passed 52/52 (20.7 seconds), with the restored V4 rejection fixture also
rechecked by the builder (2/2 focused browser tests). Final actual-file visual
comparison: normalized silhouette IoU 0.9745413702733059, bounding-box aspect
error 0.087912%, mean RGB error on overlapping silhouette 2.93944/255. These
are comparison measurements, not a claim of pixel-perfect Pivot compatibility.
Cancellation preserved the project; save/reopen preserved all imported artwork
metadata and 256 joints; no JavaScript page errors occurred. All 11 controls
passed the independent pointer test. The final render was reviewed visually.
External parent harness: `review-airplane.mjs` alongside the prototype files.
No deployment or commit. Paused for the user's allowance update.

Checkpoint: 2026-09-10. This is a bounded local assessment of the supplied
`/Users/crayner/Downloads/TC-KAAN airplane.3cb16ce7.stk`. The existing
StickMotion importer was not broadened for this model: no application source,
tests, project data, or UI behavior was changed here. No push or commit was
made, and the source binary remains outside the repository.

## Measurements

- Source size: **4,638 bytes**; SHA-256:
  `9bfb7fabdc4be95f688dd37959dc8cc8090c4fad0969af48a35b8604cefd5d2b`.
- The first byte is `0x7a`; the remaining bytes are a valid zlib stream.
- Bounded inflation produced **7,406 bytes**, beginning `a8 ff 00`.
- The measured V5 sections are 255 segment records (23 bytes each), 54
  index/double parameter records, 22 polygon records, and 277 two-byte draw
  ranks. These sections account for the complete payload with no remainder.
- Segment types: 0 = 189, 1 = 3, 3 = 3, 4 = 1, 6 = 59. Flags: 0 = 10,
  1 = 245. Eighteen segments have zero width. All parents and polygon vertex
  references are in range; the draw ranks are a complete permutation.
- The official library entry identifies the file as Pivot version 5, detail
  277, and shows a gray side-on aircraft with canopy, shaded body, and three
  landing wheels.

## One provisional render (external, read-only)

- Added external diagnostic
  `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/airplane-type6-prototype.mjs`.
  It reads the original file and renders a PNG outside StickMotion; it does
  not modify or import the project.
- The single hypothesis tested was that type 6 uses ordinary line geometry.
  For this probe only, V5 type 1 and type 3 were rendered as filled circles
  with the existing endpoint/width radius mapping; all bend records, polygon
  edges, colors, and source draw ranks were retained.
- Probe result: source 4,638 bytes / payload 7,406 bytes; 255 segments,
  54 bends, 22 polygons, 277 draw items. The painted envelope before fitting
  was x=`-342.593186..582.749627`, y=`-123.207920..119.361904`; output was
  `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/airplane-type6-prototype.png` at 800×500.
- The resulting silhouette was coherent and qualitatively matched the
  official reference: nose-left fuselage, canopy, shaded wing/tail details,
  and three landing wheels. This is visual evidence that treating type 6 as
  line-like is plausible for this file, not proof of its binary semantics or
  pixel fidelity.

## Refused / not accepted

- Refused enabling type 6 in the production importer as an alias for line.
  Official Pivot documentation describes line/circle/polygon, gradients, and
  sprites but does not define the V5 numeric type enum. The sample alone does
  not distinguish a line-cap, gradient, or other type-6 feature, so accepting
  the alias would silently approximate an unsupported feature.
- Refused enabling V5 type 1/3 circles in production from this one sample.
  Their wheel-like arrangement makes the filled-circle hypothesis plausible,
  but the exact circle fill semantics remain unverified outside this probe.
- Refused converting type-6 records to character-specific polygons or deleting
  them. The current importer therefore continues to reject this file with its
  explicit unsupported-type error, preserving data rather than claiming an
  unvalidated import.

## Initial checkpoint disposition

The complete V5 container and geometry sections are understood well enough for
an external render experiment, but production support is **not safely feasible
within this bounded task**. No application implementation change was accepted.
A future change needs additional evidence isolating the type-6 meaning (and
V5 type-1/3 circle behavior), followed by renderer, posing, save/reopen, and
export validation. Existing downloadable models can supply that evidence;
the user is not being asked to manufacture diagnostic files.

## Parent review checkpoint

- Independently inspected the official preview at
  https://pivotanimator.net/stk-library/id=0221 and the provisional PNG.
  The silhouette, canopy, layered shading and three wheels look close;
  no quantitative image-match or posing claim is made for this probe.
- Independently measured bend-table distribution: 46 type-0 and 8 type-6
  records. Type 6 cannot simply mean a curved segment.
- Accepted the diagnostic/log only; deferred production implementation.
  The prior accepted Velociraptor changes remain intact and unpushed.
- Builder reports 8 focused tests passing. No full-suite rerun was needed
  for this documentation-only repository change. Diff whitespace check passed.
- Paused for the user's allowance update, rather than expanding this checkpoint.

## 2026-09-10 continuation — bounded V5 support

The official Pivot v5 help confirms that line segments support round (default)
and square end caps, and that circles support three fill modes. The numeric V5
enum is not documented, so the following mappings are deliberately recorded as
experimental rather than as a general STK specification:

- Added V5 type `6` to the validated segment set and render it as a line with
  square caps. This is generic for every V5 type-6 segment, not a filename or
  character special case. The supplied reference/probe shows the same
  line-like geometry, while most exposed endpoints are joined or covered;
  therefore the importer emits an explicit approximation warning.
- Added V5 types `1` and `3` to circle classification. Type `1` uses the
  existing white-interior/hollow-circle renderer (the established V3 mapping),
  and type `3` uses the filled-circle renderer. Their wheel layering in this
  reference is consistent with the darker outlined outer wheel and lighter
  inner disk; other V5 circle fill variants remain unestablished. The warning
  intentionally names this as a tentative white-interior/solid-fill mapping.
- Extended artwork validation, bounds and focused tests for these V5 types.
  Square-cap bounds use a conservative `sqrt(2)` corner envelope so an angled
  cap cannot be clipped during fit. The focused V5 unit regression now uses
  unknown type `5`, preserving fail-closed coverage without rejecting the
  newly supported type `6`; the browser regression intentionally remains a
  Pivot 4 (`0x79`) type-6 fixture, proving support does not leak across
  wrappers.

The accepted implementation is limited to these files/features: `src/stk-import.js`
adds the generic V5 type set, circle classification and warnings;
`src/stk-renderer.js` adds the type-6 cap and type-1/type-3 paint mappings plus
fit bounds; and `tests/stk-import.test.mjs` adds the decoding, paint, bounds and
unknown-type regressions. Existing unrelated dirty files were preserved.

## Accepted / refused in this continuation

- **Accepted provisionally:** generic V5 type-6 square-cap rendering and V5
  type-1/type-3 circle rendering. The warning text preserves the residual
  uncertainty around the undocumented numeric enum and exact fill semantics.
- **Refused:** interpreting type 6 as a sprite, gradient, or character-specific
  polygon, and refused silently dropping its 59 records. No such alternate
  section is present in this file's fully accounted payload.
- **Refused:** claiming universal V5 support or exact Pivot compatibility. The
  accepted scope remains the measured `0x7a`/`a8` layout and this tested feature
  combination.

## Corrections recorded during review

- The first focused renderer probe treated V5 type `1` as a filled disk. That
  attempt was refused: parent review identified that a dark filled interior
  would be exposed when the layered wheel moves. It was corrected to the
  generic white-interior/colored-stroke renderer, while type `3` remains a
  source-colored filled circle. This is a measured, tentative mapping rather
  than a claim about every V5 circle variant.
- The first type-6 bounds padding used only half the stroke width. It was
  corrected to a conservative `sqrt(2)` envelope for square-cap corners at
  arbitrary angles, with a focused regression test. This avoids clipping while
  retaining the explicit cap approximation warning.

## Verification

- External cap probe generated round, butt and square variants at 400×400. The
  image comparison was visually close for all three because type-6 endpoints
  are mostly covered by the aircraft polygons and wheels; square was selected
  as the documented flat-cap interpretation and remains explicitly warned.
- Parent-side actual-file review: preview/cancel preserved project state;
  airplane inserted as **256 joints** with **11/11 visible control** checks;
  maximum rigid-descendant pose error was approximately `4.63e-13` document
  units; smoothing at `t=1` had zero channel error; save/reopen preserved the
  metadata; JavaScript page errors were zero. Parent's normalized silhouette
  IoU was `0.9745647697491576`, aspect-ratio error `0.0008791208791210092`,
  and mean RGB overlap error `2.9415/255`.
- `node --test tests/stk-import.test.mjs`: **10 passing, 0 failing** after
  these changes. `npx playwright test tests/e2e/stk-import.spec.js --workers=1`:
  **2 passing, 0 failing**. `git diff --check`: passed. No commit or push was
  made.
