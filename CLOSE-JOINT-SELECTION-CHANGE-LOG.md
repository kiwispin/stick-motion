# Close-joint selection change log — 2026-09-09

Scope: nearest-handle selection only. No geometry, serialization, importer,
model, deployment, commit, or source-artwork changes.

## Baseline

The supplied Chill prototype baseline is recorded in
`/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/CHILL-STK-PROTOTYPE-LOG.md`:
13/17 exact visible-handle clicks selected the intended handle; short endpoint
controls selected their preceding parent (13→7, 14→8, 15→11, 16→12).
That log records that no app hit-testing fix had previously been attempted.

## Modifications

1. `src/drag-controller.js`
   - Replaced first-hit return behavior with nearest-distance comparison across
     all figures and visible roots/non-root handles within the existing
     `handleRadius + 10` hit radius.
   - Kept figures scanned frontmost-first, so exact distance ties preserve the
     frontmost figure; roots are evaluated first per figure, preserving the
     existing root-first tie behavior.
   - Kept root drag offsets and speech-bubble/segment non-handle fallbacks
     unchanged. Hidden handles remain excluded from direct handle candidates.
   - Result: **accepted** pending parent real-UI validation.

2. `tests/e2e/project.spec.js`
   - Added regression coverage for a short parent/child overlap, nearest choice
     across figures, same-figure root-first ties, and exact frontmost-figure
     ties.
   - Existing group/root drag, empty-click, fallback, and hidden-handle tests
     remain in place.
   - Result: **accepted**; focused drag-controller run passed **4/4**.

## Verification

Command: `npx playwright test tests/e2e/project.spec.js -g "drag controller" --reporter=line`

Measured result: 4 passed, 0 failed, 1 worker, 363 ms. Parent review still
needs to validate the supplied Chill fixture plus donkey/elephant real-UI
drags and the broader suite.

## Parent review and additional modifications

3. `tests/e2e/project.spec.js` — stronger reviewer coverage
   - Added explicit short wrist/hand parent-child checks, including an even
     closer hidden decorative joint that must not win selection.
   - Added exactly coincident roots/children across two figures, verified
     reversing draw order reverses the tie winner, and checked speech-bubble
     fallback offsets and empty-click behaviour.
   - Measured: final focused drag-controller suite **6/6 passed**, 418 ms.
   - Decision: **accepted**. Existing tests were not weakened or removed.

4. External parent review harness
   - Added `review-close-joint-selection.mjs` in the thread's prototype folder,
     outside the repository. It loads the supplied converted Chill project,
     inserts Donkey/Elephant through real library buttons, and uses actual
     mouse gestures rather than substituting a different selection algorithm.
   - Initial harness measured coordinates before the scheduled zoom-centering
     frame ran; its root click missed. Decision: **refused as test evidence**.
     Added an animation-frame wait before taking measurements. No application
     fix was made for this harness timing issue.
   - After synchronization all 49 native-scale drags passed, but the 150%
     zoom check put the root offscreen (measured screen x=80, y=-35). Calling
     the existing stage-centering helper again did not resolve that positioning
     issue. Decision: **refused that harness positioning approach**; it was not
     repeated or used to justify changes to selection code.
   - Replaced that positioning step with ordinary viewport scrolling based on
     measured figure/screen coordinates, ensuring the control is visible before
     clicking. This changes only the isolated test viewport, not figure data.
     Decision: **accepted** after the complete review passed. Stage-centering
     behaviour itself was not changed as part of this selection fix.

## Final measured results

- Imported Chill figure: **17/17 real drag checks passed**, up from the recorded
  **13/17** baseline. All four previously obstructed hand/foot endpoints now
  select and move independently as intended.
- Donkey: **15/15** visible controls passed; Elephant: **17/17** passed.
- Total: **49/49** real drags. Every non-root drag moved only its intended
  branch, root drags translated the complete figure, and all lengths stayed
  unchanged.
- Zoom: **34/34** additional exact clicks passed (17 controls at 50% and 17 at
  150%, with the figure scrolled into view).
- Saving and browser reload preserved the complete imported joint geometry.
- Broader suite at the first reviewed test revision: **42/43 passed**, 12.5 s.
  Only the already documented pose-recovery test failed (expected `123,234`,
  recovered `400,300`). The name-recovery test passed this time. This pre-existing
  recovery failure was previously reproduced against an unchanged baseline;
  no persistence changes were attempted. The two added reviewer tests passed
  in the subsequent **6/6** focused run; the broader suite was not rerun after
  these test-only additions.
- `git diff --check`: passed.
- Detailed pointer results and screenshot are preserved outside the repository:
  `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/close-joint-selection-review-results.json`
  and `close-joint-selection-reviewed.png` in the same folder.

## Final decision

**Accepted for local user review.** The nearest-handle implementation was the
first application-code attempt and required no corrective algorithm rewrite.
The rejected items above were test-harness positioning approaches, not model
changes. No existing animation, model geometry, importer, or serialization
format was changed. Nothing was committed, pushed or deployed.

## Subsequent release approval

The user later approved the zoom review and requested a live push of the reviewed local work. This selection fix is included with that release. The zoom review reran all 49 actual drags and 34 zoomed selections successfully; see `ZOOM-CHANGE-LOG.md` for the combined review and remaining startup/recovery test caveat.
