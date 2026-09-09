# Donkey library change log

This log covers the donkey trial and subsequent approved release. It records each modification once,
the measured result, and the review decision. Earlier horse previews and
discarded approaches were not repeated; the approved relative geometry and
joint IDs from the standalone preview were used as the starting point.

## 2026-09-09

### 1. Add optional hidden pivot state to `Joint`

- **Modification:** Added `handleVisible`, defaulting to `true`, and preserved
  it in `Joint.clone()`.
- **Measured result:** Existing joints retain visible handles by default;
  donkey construction joints can be hidden without removing them from the
  hierarchy.
- **Decision:** Accepted. Focused project suite passed.

### 2. Persist hidden pivot state through project rehydration

- **Modification:** `src/project.js` now restores `handleVisible` from saved
  joint data, defaulting missing values to `true` for existing files.
- **Measured result:** A hidden joint survives JSON serialization and
  `normaliseProject()` rehydration in the focused project test.
- **Decision:** Accepted. Focused project suite passed.

### 3. Exclude hidden pivots from pointer targeting and cursor feedback

- **Modification:** `findDragTarget()` and `updateCursor()` skip joints whose
  `handleVisible` is `false`; segment hit testing remains available for figure
  selection.
- **Measured result:** A hidden joint does not become a direct joint target or
  pointer cursor; clicking its segment resolves to the figure root.
- **Decision:** Accepted. Focused project suite passed.

### 4. Add the local Donkey library model

- **Modification:** Added a Donkey library button and `createDonkey()` using
  only existing StickMotion line and circle primitives. The model uses the
  approved IDs and relative geometry. Visible controls are root, body, poll,
  muzzle, ear, tail tip, knees/feet; decorative construction joints are
  retained but hidden.
- **Measured result:** Parent review with real mouse drags measured independent
  movement: ear changes only the ear; muzzle changes the head detail branch
  without moving poll or legs; poll moves the complete head branch without
  moving legs; segment lengths remain unchanged. Review screenshots:
  `/tmp/donkey-local-review.png`, `/tmp/donkey-ear-review.png`,
  `/tmp/donkey-muzzle-review.png`, `/tmp/donkey-poll-review.png`.
- **Decision:** Accepted. Parent visual review and the focused Donkey suite passed.

### 5. Add regression coverage

- **Modification:** Added project-level coverage for hidden handle cloning,
  save/reload, cursor/target filtering, and an end-to-end Donkey library test
  covering library visibility, hidden-joint persistence, and independent
  ear/muzzle/poll hierarchy movement.
- **Measured result:** Project module suite: **16/16 passed**. Donkey end-to-end test: **1/1 passed**. Full suite: **39/40 passed**; the one failure is the existing local-project-name recovery test, which received `Untitled animation` after reload and does not exercise the donkey changes. A parallel run also reproduced that same pre-existing failure; no new donkey failure occurred.
- **Decision:** Accepted. The unrelated existing recovery failure was recorded and not repeated or changed.

### 6. Release approval

- **Decision:** User accepted the local trial and explicitly requested publication.
- **Scope:** Publish the reviewed Donkey model, hidden-handle support, regression tests, and this log. No additional application changes.
- **Preflight:** Upstream remains `ea0d188`; `git diff --check` passed. Reuse the recorded verification above.
