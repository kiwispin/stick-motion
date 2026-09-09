# Elephant library change log

This log covers the elephant library trial and subsequent approved release. The model is built
from StickMotion's existing `Figure`/`Joint` line and circle primitives; no
renderer or drag-engine changes were made.

## 2026-09-09

### 1. Add the Elephant library entry and factory

- **Modification:** Added an Elephant button to the Model Library and routed
  `addFromLibrary('elephant')` to a new `createElephant()` factory.
- **Measured result:** The factory contains the approved 30-joint rig, with
  17 visible controls and 13 hidden construction/eye joints. It preserves the
  approved body, four legs, tail, head, ear, eye, and four visible trunk
  sections, including the approved elephant and ear/eye colors.
- **Decision:** Accepted.

### 2. Correct the factory's root reference during porting

- **Modification:** Rejected the initial zero-offset construction reference
  and restored the approved prototype reference point `[174,98]`. This keeps
  every generated segment's length and angle identical to the approved rig;
  the Figure itself remains at normal library defaults (`x=400`, `y=300`,
  `scale=1`).
- **Measured result:** The four root links (`rump`, `farFrontHip`,
  `nearFrontHip`, and `headBase`) match the approved lengths and angles in the
  focused regression test. Parent review also confirmed exact geometry,
  colors, and visibility for all 30 joints.
- **Decision:** Accepted after correction.

### 3. Add insertion, persistence, hierarchy, and cloning coverage

- **Modification:** Added an end-to-end regression test that clicks the real
  library button, saves and reloads the project, checks the approved rig and
  colors, verifies head/ear/trunk/leg/tail hierarchy movement, and confirms
  cloned joints remain independent while hidden handles are preserved.
- **Measured result:** Focused Elephant test: **1/1 passed**. Parent's native
  pointer review dragged all **17/17 visible controls**; each intended branch
  moved, all segment lengths stayed unchanged, and save/reload reproduced the
  exact rig. Review screenshot: `/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/elephant-library-review.png`.
- **Decision:** Accepted. The parent full-suite run is **38/40** with the
  pre-existing pose-recovery failure and intermittent local-project-name
  recovery failure; baseline checking reproduced the pose failure and did not
  implicate this Elephant change.

### 4. Scope and release decision

- **Scope:** Elephant library UI entry, factory, and regression coverage only.
- **Decision:** Accepted for parent review. No commit, push, deployment, or
  unrelated rendering/interaction changes were made.

### 5. Final parent review

- **Modification:** Strengthened the new regression test to wait for the
  elephant's asynchronous recovery and reject movement of each unrelated
  branch individually. Refused an intermediate patch that placed the wait in
  the existing stickman test; it was removed and placed in the Elephant test.
- **Measured result:** Final focused test **1/1 passed**; final diff confirms
  existing tests are unchanged. `git diff --check` passed. The factory matches
  all 30 approved joints exactly, including lengths, angles, hierarchy, colors,
  thicknesses, radii, and handle visibility. All **17/17** actual pointer
  controls passed and reloading preserved the full rig.
- **Baseline evidence:** The broader existing suite ran **38/40**. A pristine
  `HEAD` archive reproduced the pose-recovery failure (expected position
  `123,234`, recovered `400,300`); its name-recovery test passed in that run.
  The name test's intermittent failure was already recorded in the Donkey log.
  No recovery-code changes were attempted as part of this task.
- **Decision:** Accepted for local trial after parent visual/code review.
  Publishing still requires the user's approval.

### 6. Ear colour correction and publication approval

- **User decision:** The user reported that recolouring the elephant left its
  ear grey, then explicitly requested "Fix and push!". The fixed-grey-ear
  design is refused; inheriting the selected body colour is accepted.
- **Modification:** Removed the ear's `#848371` colour override from the
  factory. Its colour now inherits the figure colour through the existing
  renderer. The eye retains its explicit white colour. No geometry, hierarchy,
  drag, or persistence implementation changed.
- **Regression:** Added a real palette-click test that samples rendered ear,
  body and eye pixels, compares geometry before/after recolouring, and repeats
  the pixel/geometry checks after saving and reopening. Updated the factory
  expectation from fixed grey to inherited (`null`) ear colour.
- **Before fix:** The new test reproduced the bug: black body pixel
  `[0,0,0,255]`, but ear pixel `[132,131,113,255]`. This failing baseline is
  diagnostic evidence, not a repeated modification attempt.
- **After fix:** Black body/ear both `[0,0,0,255]`; red body/ear both
  `[239,68,68,255]`; eye remains `[255,255,255,255]`. All compared geometry
  fields were unchanged and the red result survived reload. Focused tests:
  **5/5 passed** (Elephant rig, recolouring, Donkey, hidden-handle persistence
  and hit testing). `git diff --check` passed. Broader suite results from
  section 5 remain recorded; unrelated recovery code was not altered.
- **Scope:** Publish the reviewed Elephant library addition, this fix, tests
  and log. Existing saved local-trial figures are not silently rewritten;
  adding a fresh library Elephant gets the corrected inherited colour.
- **Decision:** Accepted for publication. Upstream preflight remained
  `cac9541`; no incoming changes required merging.
