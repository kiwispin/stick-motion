# Giraffe2 STK compatibility checkpoint

Checkpoint: 2026-09-12. Luna xhigh builder/parent review. This is a bounded
compatibility check of the official Pivot Animator library entry
[Giraffe2](https://pivotanimator.net/stk-library/id=021q), creator Godzilla,
Pivot 5 detail 255. The source binary and reference image remain outside the
repository; no commit or push was made.

## Source and measured layout

- Source: `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/Giraffe2.b2992471.stk`.
- Size: **4,500 bytes**. SHA-256:
  `141bf5d0fb55103833313c2dae8c5b466ad3108bcccfa6eeaaa90936804f0fcc`.
- Wrapper byte: `0x7a`; the remaining bytes are a valid zlib stream.
- Inflated payload: **7,589 bytes**, header `a8 ca 00`.
- The complete payload is accounted for as 202 V5 segment records (23 bytes
  each), 158 curve parameter records (10 bytes each), 53 polygon records
  (1,744 total vertex references), and 255 two-byte draw ranks. There are no
  unaccounted or trailing bytes.
- Segment types are `0: 201`, `1: 1`; flags are `0: 31`, `1: 171`. The single
  type-1 segment is within the existing generic V5 circle mapping. All 202
  parent references are backward/in range, all 255 draw ranks form a complete
  permutation, and every curve/polygon reference is valid.

## Compatibility decision

- **Accepted:** Existing V5 importer behavior. `decodeStkBytes` accepts and
  validates the complete payload; `createFigureFromStk` creates 203 native
  joints (root plus 202 segments), preserving the source bend table, colors,
  hierarchy, polygon geometry, and draw order.
- **No application change:** No concrete Giraffe2-specific or generic parser,
  renderer, control, persistence, or export defect was found. Existing V5
  type-1 handling remains intentionally generic and warning-bearing.
- **Refused:** Character-specific geometry patches, type-enum changes,
  polygon or bend rewrites, and broad STK support expansion without a failing
  measured case. The source file is not copied into the repository.

## Parent verification

- Actual-file preview and cancel were non-mutating; cancellation preserved the
  project exactly. Inserted figure had **203 joints** and **32 visible
  controls** with zero JavaScript page errors.
- All **32/32** visible controls passed pointer posing. Maximum rigid-descendant
  error was `3.595093471822542e-13` document units; pointer rounding error was
  `1.0829963764434885` document units.
- Double flip maximum angle error was `8.881784197001252e-16` radians. Smooth
  interpolation at `t=1` changed zero channels and produced a painted midpoint.
- Save/reopen preserved the imported artwork metadata exactly.
- Against `giraffe2-reference.png`, the parent measured reference bounds
  `45,1,310,398`, render bounds `233,36,334,428`, normalized silhouette IoU
  **0.9839182466048138**, aspect-ratio error **0.18957060752865518%**, and
  mean RGB overlap error **1.0157706289119086/255**. Visual review found a
  matching giraffe silhouette and layering; these measurements are bounded
  evidence, not a claim of universal or pixel-perfect Pivot compatibility.

## Verification and scope

- Focused decode/validation checks passed for the supplied file; the final
  repository unit suite passed **14/14**.
- No application source or tests were modified. This log is the only repository
  change for this checkpoint; `git diff --check` passed.
- Parent reused the existing external review harness in memory for this file;
  the actual preview, control, save/reopen, and visual checks were performed by
  the parent and are recorded here without duplicating them.
- The earlier Elephant3 selection was stopped before any application change;
  it is not part of this distinct Giraffe2 checkpoint.
