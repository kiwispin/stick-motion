# Zoom change log

Date: 2026-09-09 (Pacific/Auckland)

This log records Luna (xhigh)'s implementation, the review correction, and the parent's independent measured results. The existing `CLOSE-JOINT-SELECTION-CHANGE-LOG.md` is unrelated and was not edited. No refused implementation was repeated.

## Baseline (measured before this change)

- At a 1500×1000 viewport, clicking 100% → 110% moved the document point under the viewport centre by 415.35 CSS px.
- The zoom pill moved from approximately (1145, 792) to (879, 473) after the same zoom action/scroll state.
- The oversized canvas was a flex-centred child of the scrolling element, coupling flex centring and scroll origin.
- Zoom called `setCanvasSize()`, which redrew and queued local persistence even though document settings/data had not changed.
- Result: refused as unacceptable.

## Accepted changes

1. Added a non-scrolling `#canvas-shell`, explicit `#canvas-stage` scroll content, and stable canvas offsets. The canvas is centred only while its visual bounds fit; oversized stages start at a reachable scroll origin.
2. Moved the zoom pill and mobile inspector toggle outside the scrolling content so both remain fixed and reachable after scrolling/zooming. Marquee remains in `#canvas-area` so its existing wrapper-coordinate math and `stagePadding: 400` contract are unchanged.
3. Reworked `setZoom()` to capture the document point under the viewport centre, change only CSS viewport geometry, then restore that point with clamping to the real scroll range. `fitStage()` computes a fit zoom and explicitly centres the document.
4. Separated zoom from document sizing: `setCanvasSize()` still resizes, renders, and saves; project loading still applies its saved dimensions through `applyCanvasSize()`. Zoom changes neither backing dimensions nor figures, frames, history, or local project serialization.
5. Interim review measured the first explicit-stage version opening at document point approximately (212, −4) instead of the expected default centre (400, 250) because its initial scroll position was zero; that result was refused. Added explicit centring after initial load, new project, and project open, then accepted the corrected result after focused verification.

## Measurements and verification

- Focused UI regression suite: `npx playwright test tests/e2e/zoom.spec.js --output=test-results/zoom-focused` — 4 passed.
- Focused coverage measured centre-anchor preservation through zoom-in/out on a panned non-default 1200×700 document, initial/new/open centring, fit containment, actual middle-button panning, fixed overlay reachability, and exact serialized project equality before/after zoom.
- First independent review: zoom-anchor error ≤0.6872 CSS px, but initial centring failed; refused pending the correction recorded above.
- Final independent review: **32/32 measured checks passed**, maximum error **0.5000000000000455 CSS px** (scroll rounding). Covered 1500×1000, 980×720, 560×800, and a 1200×700 document; initial/open centring, zoom buttons/reset, panned anchors, fit containment, 10%/500% bounds, actual middle-button pan, fixed controls, and exact serialized project equality. Accepted.
- Re-ran the prior independent joint-selection review with the new layout: **49/49 actual joint drags** (Chill 17, Donkey 15, Elephant 17), **34/34 zoomed handle selections**, and unchanged geometry after save/reload. Accepted.
- Visually inspected desktop and narrow-screen screenshots: the document is centred and zoom controls remain visible. Accepted.
- Full-suite first run: **48 passed, 1 failed**. The failing new zoom test timed out during editor initialization (`app.frames` empty), before performing any zoom. This is not a successful full-suite result; no assertions were weakened and no startup/recovery code was modified. A second unchanged run was requested to check reproducibility.
- Full-suite second unchanged run: **47 passed, 2 failed**. The same pre-zoom initialization timeout recurred, plus the existing project-name recovery test failed. Refused as a clean full-suite result. A single-worker run was requested to separate concurrent test-server/startup behaviour from zoom behaviour; this reruns tests, not a previously refused implementation.
- Full-suite single-worker run (`npx playwright test --workers=1`): **48 passed, 1 failed in 14.1s**. All four zoom tests passed; only the existing name-recovery test failed (expected `Rocket rehearsal`, received `Untitled animation` after reload). The startup timeout did not recur in this run; its underlying cause was not diagnosed or fixed in this zoom task. The full suite remains non-green.
- `git diff --check`: passed. Parent accepts the scoped zoom fix for local review, with the above startup/recovery caveat. No commit, push, or deployment was performed.

Review artifacts are in `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/`: `zoom-baseline.json`, `zoom-review-results.json`, `review-zoom-anchor.mjs`, `zoom-reviewed-*.png`, and `close-joint-selection-review-results.json`.

## Refused scope

- No wheel or pinch zoom gesture was added; existing middle-mouse and two-touch panning were preserved.
- No edits were made to the previous dirty joint-selection files, and no unrelated pose-recovery failure was changed.

## Release approval

- User approved the local result and requested a live push. This release includes the reviewed zoom and close-joint selection fixes, their regression tests, and both change logs. No new application-code modifications were made during release preparation.
- Fetched GitHub before release: local `main` and `origin/main` both at `8c3f5f8`; no incoming changes to merge. The known startup/recovery test caveat remains unresolved and disclosed.
- Release verification: `npx playwright test tests/e2e/zoom.spec.js tests/e2e/project.spec.js --workers=1` — **23/23 passed in 1.8s**; `git diff --check` passed. Accepted for the user-authorized release.
