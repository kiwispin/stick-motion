# Background toggle change log

Release authorization: user approved pushing this reviewed change live on
2026-09-14. Remote main was fetched and confirmed aligned before committing.
The no-push statements below describe the earlier local review checkpoint.

Date: 2026-09-14 (Pacific/Auckland)

Builder: Luna (xhigh). Parent agent reviews the diff and regression
independently. This is a local-only change; no commit or push was performed.

## Scope

Make the existing Settings background-image action a stateful toggle. It shows
`Set Background Image` when no background is present and `Clear Background
Image` when one is present. Clearing removes only `backgroundData` and
`bgImage`, redraws the stage and timeline, and leaves all figures, frames and
frame delays unchanged. Setting the image again remains available after a
clear.

## Accepted implementation

1. Added a shared settings-button label/ARIA/title synchronizer so the control
   reflects background state after startup, restore, open settings, set, clear,
   new project and project load.
2. Added `toggleBackgroundImage()` and `clearBackgroundImage()`; clear
   invalidates pending background reads/decodes before nulling both background
   fields, then renders, refreshes timeline thumbnails, and autosaves.
3. Added a monotonic background-load token to file-reader and image-load
   callbacks so stale asynchronous work cannot restore a cleared or replaced
   image.
4. Added a focused browser regression covering add/clear labels, the rendered
   background pixel disappearing, exact frame/figure serialization preservation,
   set-again behavior, and no-background persistence after reload.

## Refused / unchanged

- No changes were made to figure, frame, delay, undo-history, renderer, project
  format, or background validation behavior.
- No broad refactor, commit, push, deployment, or repeated refused attempt was
  made.

## Verification

- Initial focused browser assertion was refused because it compared raw angle
  floats across the existing project normalisation boundary (`0.2` versus
  `0.19999999999999998`), not because clear changed project data. The test was
  corrected to compare a stable 15-significant-digit serialization; no
  application behavior was changed or repeated.
- Final focused regression:
  `npx playwright test tests/e2e/editor.spec.js --grep "background image button" --workers=1`
  — **1 passed, 0 failed, 2.2 seconds**. This includes delayed stale-restore
  callback invalidation, set/clear/set-again, rendered-pixel removal, exact
  frame/figure preservation, saved-background reload labeling, no-background
  reload persistence, and New Project labeling.
- Parent’s independent pre-edge full-suite review: **53/53 browser tests
  passed in 16.4 seconds** and **17/17 unit tests passed in 247.73 ms**.
- Parent independently reviewed the source diff and accepted the scoped
  implementation; the final edge-coverage addition did not change application
  code.
- Final `git diff --check`: passed. No commit or push was performed.
- Parent reran the final expanded background regression independently:
  **1/1 passed in 2.0 seconds**. Final test diff accepted; cross-reload
  comparisons use the documented 15-significant-digit normalization.
