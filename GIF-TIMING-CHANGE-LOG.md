# GIF timing investigation — 2026-09-09

User requirement: record every code change, measured results, and accepted/refused status. Review this log before another attempt; do not repeat failed changes.

## Baseline (read-only)

- Source: `/Volumes/Student Work/jonah-dubist.json`; 9 frames, 17 FPS, all duration multipliers 1, smoothing and looping enabled.
- Intended loop: 529.411765 ms.
- Supplied GIF: 36 encoded frames, 18 × 10 ms and 18 × 20 ms; encoded loop 540 ms.
- Applying browser delay handling (10 ms becomes 100 ms): 2160 ms, 4.08 times intended duration. This is calculated from parsed GIF blocks, not a stopwatch measurement.
- Prior approaches reviewed: 10 ms quantisation in `a8f6c7d`, 60 FPS smoothing in `c03c440`. Neither prevents browser expansion of 10 ms delays. Do not repeat either as a standalone timing fix.

## Attempt 1 — browser-safe GIF schedules

- Change: GIF-specific cumulative timing, minimum 20 ms encoded delays, and interpolation positions based on elapsed time. Leave WebM scheduling unchanged.
- Files changed: `src/export-utils.js` (GIF-specific scheduler), `index.html` (use scheduler and elapsed-time interpolation), `tests/gif-timing.test.mjs` (binary encoder and timing regressions), and this log. No other code changes attempted.
- Measured result: 26 output samples, 530 ms total versus 529.411765 ms intended (error +0.588235 ms, +0.111%). Every output delay is at least 20 ms. The bundled GIF worker was run with synthetic 2×2 pixels and Jonah's exact timing, and its actual GIF binary was parsed. This verifies encoding and timing, not Jonah's rendered artwork or wall-clock browser playback.
- Regression results: 3/3 Node tests pass. Tested 400-frame sequences at 1, 12, 17, 24, and 30 FPS, smoothing on/off and varying frame holds. Each cumulative boundary stays within 5 ms of intended time for these cases. Original GIF was parsed again: 540 ms encoded, 2160 ms after browser delay handling.
- Command: `GIF_TIMING_INPUT='/Volumes/Student Work/jonah-dubist (1).gif' node --test tests/gif-timing.test.mjs`.
- Full browser suite: attempted `npm run test:e2e`; blocked before tests by `PermissionError: Operation not permitted` when binding the local HTTP server. No failing application test was observed, and no browser pass is claimed.
- Status: **accepted locally on measured timing/encoder evidence; release verification pending**. No refused modification, no repeated attempt, no push or deployment.
- Limitation: preserving every source frame whose duration is below 20 ms necessarily lengthens that portion of a browser-safe GIF. The regression explicitly documents this case (two 3.33 ms source frames become two 20 ms samples). Jonah's frames are 58.82 ms, so this limitation does not affect the reported fix.
- Browser handling reference: https://bugs.webkit.org/show_bug.cgi?id=14413 (delays <=10 ms mapped to 100 ms).

## Publication attempt

- User authorized publishing the fix. Re-ran all three timing tests: passed; Jonah timing remains 530 ms.
- `git diff --check` passed.
- Git staging was refused by the environment: `.git/index.lock: Operation not permitted`. Commit and push did not execute. Changes remain local and uncommitted. This was a publication attempt, not a repeated code modification.

## Full-access verification and release

- User enabled full access; Git fetch succeeded and upstream remains `c03c440`. No intervening upstream changes.
- Actual Chromium export: opened the supplied JSON through the file input and exported with the app's real GIF encoder. Result `/tmp/jonah-dubist-fixed.gif`: 96,985 bytes, 26 frames, 530 ms encoded and browser-adjusted duration. Serialized project before and after export is identical. No student file was modified.
- `npm run test:e2e`: 36 passed, 1 project-name recovery test failed. Isolated rerun `npx playwright test --grep 'names and recovers'` passed without any code change. This records the intermittent failure rather than claiming a clean full-suite run.
- Timing regression tests: 3 passed, including parsing the actual Chromium-exported file.
- Attempt 1 status: **accepted for release**. No additional code modifications or repeated implementation attempts. Git publication follows this verification.
