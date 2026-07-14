# StickMotion Implementation Plan

## Goal

Turn StickMotion into a dependable, accessible, classroom-ready animation editor while retaining its local-first model and familiar creative workflow. Work is incremental: preserve existing projects and extract testable responsibilities from the current single-file implementation over time.

## Implementation status

### Completed — Reliability foundation, first pass

- New projects now create and display a real Frame 1 immediately.
- The active stage is committed before local save, project download, and GIF export, preventing the latest pose from being replaced by an older frame on reload.
- Project files now use version 4 and preserve the active frame, playback settings, and data-URL background images.
- Existing version-3 local project data with an unsynchronised live figure list migrates into Frame 1.
- Imported document dimensions are constrained to 64–4096px.
- Project download URLs are revoked after use and downloaded files use the name `stickmotion-project.json`.
- Undo/Redo now covers text edits, frame creation, and frame-duration changes.
- Initial-frame timeline rendering is covered: a fresh project creates one stored frame, one thumbnail, and the `Frame 1 of 1` counter.

### Verified

- Fresh project creation, active-frame persistence across reload, downloaded-project serialization, version-3 migration, background persistence, and dimension validation.
- Text Undo/Redo, frame-add Undo, and frame-duration Undo.
- Browser startup and timeline rendering smoke checks.

### Completed — Core interaction, first pass

- Unified inspector feedback for single, multi-, group, pasted, and marquee selections.
- Multi-selection now keeps a clear count and disables single-figure controls while preserving Group/Ungroup actions.
- Delete and keyboard Delete now remove every selected figure; Undo restores the full selection.
- Grouping preserves the selected group instead of leaving a mismatched hidden selection state.
- The Select tool is now the visibly active editor state; Add Stickman is correctly presented as an action rather than a persistent mode.
- The save badge now reports `Saved` or `Save failed` instead of the misleading static `Storage` label.
- Adding or duplicating a frame selects the newly active timeline frame; previous/next frame navigation scrolls that frame into view.

### Verified

- Single and multi-selection inspector state, pasted multi-selection, group selection, multi-delete, keyboard deletion path, and Undo after deletion.
- Add-frame selection and Undo, save-status rendering, and tool active-state rendering.

### Completed — Responsive, touch, and accessibility foundations

- Browser zoom is no longer disabled, so students can use their device’s built-in magnification.
- The inspector becomes an on-demand drawer at tablet/narrow widths, preserving the stage as the primary workspace.
- The top bar and playback bar now scroll horizontally when space is constrained instead of clipping essential controls.
- Added Fit Stage, reset zoom, middle-mouse panning, and two-finger touch panning.
- Increased coarse-pointer target sizes for tools, transport, palette, and panel actions.
- Added a consistent visible keyboard-focus treatment and accessible names for key icon controls.
- Palette swatches, library choices, timeline frames, and group controls are now keyboard-operable semantic controls.
- Playback/toggle state is exposed with `aria-pressed`; save feedback is announced via a live region; dialogs have initial dialog semantics.

### Verified

- Visual browser smoke checks at 1366×768 desktop and 768×1024 tablet portrait.
- Tablet drawer visibility, compact controls, stage visibility, timeline access, and the no-clipping horizontal overflow treatment.
- Runtime-created color swatches and timeline frames expose keyboard focus and accessible labels; library choices are native buttons.
- Browser startup/rendering after the interaction and responsive changes; whitespace checks pass on changed project files.

### Completed — Accessible dialogs and shortcut onboarding

- Added an in-app Help & Shortcuts control with the editor’s actual keyboard commands and stage navigation guidance.
- Dialogs now place focus on their most useful initial control, keep Tab navigation inside the open dialog, close with Escape, and return focus to the control that opened them.
- Applied the same keyboard dialog behavior to confirmation, settings, library, Help, and Figure Designer surfaces.
- Added dialog semantics and a keyboard-focusable, named Figure Designer canvas.
- While a dialog is open, editor keyboard commands no longer fire behind it.

### Verified

- JavaScript syntax validation, whitespace validation, and browser startup/render checks pass.
- Browser DOM verification confirms Help, confirmation, settings, library, and designer dialog semantics, as well as the Help close control and live save-status markup.

### Completed — Safe project import and first-run orientation

- Project files are limited to a classroom-safe size before reading and now enforce caps for frames, figures, joints, groups, text, and embedded background data.
- Imported figures and joints are rebuilt field-by-field instead of copying untrusted object properties.
- Project loading rejects invalid numeric values, duplicate IDs, broken parent links, and cyclic joint hierarchies before rendering.
- Background imports are restricted to PNG, JPEG, GIF, and WebP with a size cap; unsafe or unsupported embedded background data is ignored.
- Added a concise first-run walkthrough for posing, adding frames, and exporting. It appears only when no saved project is restored and can be dismissed with the normal dialog controls.

### Verified

- Targeted import regression cases: valid projects, cyclic joints, duplicate IDs, invalid coordinates, oversized frame lists, overlong text, prototype-pollution payloads, and safe/unsafe background data.
- One-time first-run preference behavior in the regression harness.
- Browser startup, runtime markup, and visual screenshot check of the orientation dialog.

### Completed — Visual accessibility and error feedback

- Raised the contrast of editor surfaces, borders, primary/secondary/tertiary text, labels, and disabled controls.
- Increased small instructional and status text where space allows, while preserving the compact editor layout.
- Strengthened keyboard focus visibility with a high-contrast focus ring.
- Replaced routine browser alerts for project, grouping, and export errors with consistent in-app error feedback that remains visible longer and is announced to assistive technology.

### Verified

- Contrast regression checks: primary text 15.09:1, secondary text 8.59:1, tertiary text 5.48:1, and focus indicator 8.39:1 against their relevant editor surfaces.
- Accessible error-toast regression test, JavaScript syntax validation, whitespace validation, and browser visual smoke check.

### Completed — Offline dependencies and stress regression

- Removed unused Tailwind CDN and web-font dependencies; the editor now uses robust local system font stacks.
- Bundled gif.js 0.2.0 and its worker in `vendor/`, and changed GIF export to use the local worker directly.
- Editing, onboarding, and GIF-export dependencies no longer require a network connection.
- Exercised import normalization with 100 frames, 25 figures per frame, and 12 joints per figure, plus two-finger panning behavior.

### Verified

- Browser startup at 1366×768 and 768×1024 with DNS resolution disabled.
- Local GIF library and worker presence, no external resource references in the app, JavaScript syntax, and whitespace checks.
- 100-frame stress normalization completed in 74.1 ms; touch-pan regression passed.

### Completed — Persistent end-to-end browser regression suite

- Added a minimal Playwright harness that serves the static editor without introducing a build system.
- Added browser coverage for first-frame startup, active-pose persistence, selection/group/delete/Undo, keyboard frame Undo, malformed project imports, tablet drawer behavior, two-finger panning, offline startup, and GIF export.
- The offline test blocks external requests and confirms the locally bundled GIF worker produces a real `animation.gif` download.
- Test artifacts and dependencies are ignored from version control; the suite can be run with `npm run test:e2e` after installing dependencies.

### Verified

- Six browser end-to-end tests pass in approximately six seconds in the local Chromium environment.

### Completed — Modularization, first safe extraction

- Converted the static entry script to an ES module while preserving the existing `window.app` contract used by controls and student-facing workflows.
- Extracted the figure, joint, and group models into `src/models.js`.
- Extracted project limits, validation, hydration, cloning, dimension clamping, and serialization into `src/project.js`.
- Local save, project download, and project import now share the extracted project boundary.
- Added direct module regression coverage for validated hydration, cyclic-joint rejection, and serialization.

### Verified

- Eight tests pass: six browser workflows and two direct project-module tests.
- Module syntax checks and whitespace checks pass; the browser verifies both modules load from the static server.

### Completed — Modularization, history and export renderer

- Extracted bounded Undo/Redo snapshot management into `src/history.js`; the editor controller now delegates capture, Undo, Redo, and resets to that module.
- Extracted reusable document-to-canvas rendering into `src/renderer.js`; PNG and GIF export now share it without changing the interactive stage renderer.
- Added module-level coverage for history snapshot isolation and renderer paint/delegation behavior.

### Verified

- Ten tests pass: six browser workflows and four direct module tests.
- Browser tests confirm all four modules load, and a real offline GIF export still completes with the local worker.

### Completed — Canvas interaction primitives

- Extracted canvas coordinate conversion, wrapper coordinates, segment hit-testing, and speech-bubble hit-testing into `src/canvas-interaction.js`.
- The controller now delegates those pointer primitives while preserving existing mouse and touch behavior.

### Verified

- All ten browser and module tests still pass with the interaction module loaded from the static server.

### Completed — Marquee interaction, first extraction

- Added `src/marquee.js` for marquee bounds and meaningful-drag threshold logic.
- The existing marquee selection completion path now delegates those calculations to the module without changing student gesture behavior.

### Verified

- All ten browser and module tests pass with the marquee module loaded from the static server.

### Completed — Dedicated drag interaction controller

- Expanded `src/drag-controller.js` to own root movement, selected-figure and group movement, joint rotation/free-joint movement, cursor state, marquee creation, visual updates, completion, and stage-coordinate conversion.
- Kept the editor controller responsible only for applying selection results and rendering, so mouse and touch gestures retain their established student-facing behavior.
- Added direct controller coverage for grouped movement, joint rotation, reversed marquee geometry, and marquee-to-canvas coordinate conversion.

### Verified

- All eleven browser and module regression tests pass, including existing persistence, selection, Undo, touch-pan, offline GIF export, and the new drag-controller tests.

### Completed — Pointer hit-testing and drag-target selection

- Moved the ordered hit-testing for root handles, joint handles, speech-bubble bodies, and figure segments into `src/drag-controller.js`.
- Preserved the established hit priority and Ctrl/Cmd selection behavior in the editor controller, so familiar student gestures remain unchanged.
- Added direct regression coverage for root, joint, segment, miss, and hit-priority outcomes.

### Verified

- All twelve browser and module regression tests pass, covering the extracted interaction path alongside persistence, selection, Undo, touch-pan, and offline GIF export.

### Completed — Project names and draft recovery

- Added a visible, editable project name that is persisted locally and included in downloaded project files.
- Project downloads now use a safe filename derived from the project name instead of a generic filename.
- Advanced the project format to version 5 while retaining migration defaults for older projects without a name.
- On reload, the app restores the latest local draft, announces the recovery, and shows a clear `Recovered draft` status with guidance that New starts fresh.
- Added browser coverage for naming, saving, reload recovery, and the recovery-state affordance.

### Verified

- All thirteen browser and module regression tests pass, including the new project recovery path plus existing persistence, selection, Undo, touch-pan, and offline GIF export coverage.

### Completed — Repeatable first-run quick start

- Reframed the first-run guidance around the actual first animation students make: pose, press Space for the next frame, adjust, and play.
- Added the same concise three-step guidance to Help so students can review it without leaving their project.
- Added a `Show quick start` action in Help that safely reopens the walkthrough without conflicting dialogs or resetting the project.
- Added end-to-end coverage for opening Help, reopening the walkthrough, verifying its Space instruction, and returning to the editor.

### Verified

- All fourteen browser and module regression tests pass, including the repeatable onboarding flow plus existing persistence, interaction, touch-pan, and offline GIF export coverage.

### Completed — Classroom handoff and export feedback

- Project JSON, PNG-frame, and GIF exports now use a safe filename derived from the visible project name.
- Save and export feedback now names the exact file students created, making handoff and submission clearer.
- GIF object URLs are revoked after download, matching the project and frame export cleanup behavior.
- Added end-to-end coverage for named JSON and PNG downloads and updated offline GIF coverage for the named output.

### Verified

- All fifteen browser and module regression tests pass, including named project handoff, PNG export, offline GIF export, onboarding, persistence, interaction, and touch-pan coverage.

### Completed — Student-facing microcopy and feedback consistency

- Replaced the ambiguous empty selection label with a direct next action: `Select a figure on the stage`.
- Made the empty-groups guidance name both the multi-select gesture and the Group action.
- Added clear confirmations for grouping, ungrouping, background placement, clearing the stage, starting a new project, and opening a named project.
- Strengthened destructive-action and local-save language so students know when Undo is available and what to do if browser storage fails.
- Added browser coverage for empty-selection guidance and grouped/ungrouped completion feedback.

### Verified

- All sixteen browser and module regression tests pass, covering polished feedback alongside named handoff, onboarding, persistence, interaction, touch-pan, and offline GIF export paths.

### Completed — Release-readiness verification

- Inspected the working diff and preserved the pre-existing unrelated edits in `README.md`, `_stitch.py`, and `_temp_body.html` without modification.
- Confirmed the StickMotion source diff has no whitespace errors and all extracted JavaScript modules pass syntax checks.
- Performed fresh visual smoke checks at 1366×768 desktop and 768×1024 tablet portrait. The stage, toolbar, timeline, project name, recovery state, and tablet inspector affordance render cleanly.
- Reconfirmed the full automated suite: sixteen browser and module regression tests pass.

### Completed — Starter animation templates

- Added a top-bar Templates picker with Walk, Jump, Wave, and Blank canvas starters.
- Each starter is labeled with its frame count or blank-canvas state so students know what they are choosing before they commit.
- Template selection uses an explicit replacement confirmation, resets project-only state, gives the project a useful name, and leaves every generated frame editable.
- Added browser coverage for the complete Walk picker flow and for the frame/figure/name outcomes of all four starters.

### Verified

- All seventeen browser and module regression tests pass, including every starter template plus existing onboarding, persistence, interaction, touch-pan, named export, and offline GIF coverage.

### Fixed — Frame-one onion-skin ghost

- Corrected onion-skin rendering so it draws only the actual preceding timeline frame; Frame 1 never uses its unsaved current pose as a ghost reference.
- Removed the misleading active-pose comparison path that caused a duplicate/ghost figure while dragging on the first frame.
- Added a browser regression that proves Frame 1 draws zero onion ghosts and later frames draw exactly one previous-frame ghost.

### Verified

- All eighteen browser and module regression tests pass, including the new Frame 1 onion-skin invariant plus templates, onboarding, persistence, interaction, touch-pan, named export, and offline GIF coverage.

### Reworked — Animation-principled starter templates

- Rebuilt all motion templates in a dedicated `src/templates.js` module after reviewing established animation guidance for contact/down/passing/up walk poses, opposing arm swing, jump anticipation/apex/landing, and pose-to-pose waving.
- Replaced the translating four-frame Walk with an eight-pose in-place cycle. The root stays fixed horizontally, the body has controlled vertical weight shift, contact legs alternate, at least one foot remains planted in every pose, and the arms counter-swing.
- Replaced the five-frame Jump with nine readable poses: neutral, anticipation crouch, takeoff, rise, apex, fall, contact, landing compression, and settle. The torso/head chain remains stable throughout.
- Replaced the ambiguous four-frame Wave with an eight-pose raise/wave/lower sequence. The feet and root stay planted while the raised hand travels clearly above the head.
- Added a two-bone leg target solver so planted feet are derived from reachable pivot geometry rather than guessed joint angles.
- Expanded regression coverage to assert the motion itself: fixed Walk root, alternating contacts, foot plants, opposing arms, Jump arc and head stability, and Wave hand height/travel.
- Visually reviewed full contact sheets for all 25 generated poses after the automated checks.

### Verified

- All eighteen browser and module tests pass after the complete template rewrite, including the new motion-quality invariants and all existing editor regressions.

### Disabled — Starter animation templates

- Removed the student-facing Templates button, picker dialog, confirmation flow, and application methods after visual review found the generated motion below the required quality bar.
- Kept the experimental generator module isolated in the source tree for a future ground-up redesign; it is not imported or reachable from the app.
- Replaced the template-motion test with a regression that proves students cannot see or invoke templates.

### Verified

- All eighteen browser and module regression tests pass, including the withdrawn-template guard and existing persistence, interaction, accessibility, import, export, offline, and touch coverage.

### Confirmed — Pivot-style Space shortcut

- Space intentionally adds a frame while stopped and stops playback while playing, matching the established Pivot Animator workflow this editor follows.
- The quick start and Help retain this instruction; this is a product convention, not an outstanding playback defect.

### Completed — Timeline fidelity and responsive updates

- Timeline thumbnails now use the editor’s real figure renderer, so text, speech bubbles, circle segments, colours, and the current background appear as students see them on the stage.
- The active frame’s preview refreshes on the next animation frame after an edit, avoiding a full timeline rebuild while posing or dragging.
- Frame-duration scrubbing now updates only the affected thumbnail’s timing badge and duration bar instead of recreating every thumbnail.
- Background changes deliberately refresh all thumbnails because the same project background belongs in every frame preview.

### Verified

- Added browser coverage for text, speech, background pixels, live active-thumbnail refresh, and duration-slider non-rebuild behavior.
- All nineteen browser and module regression tests pass.

### Completed — GIF export progress and safe cancellation

- GIF export now opens a focused progress dialog, disables duplicate export requests, and reports both frame preparation and encoder progress.
- Students can cancel from the dialog (or with Escape). Cancellation stops the encoder where possible, closes the dialog, restores the exact active frame, returns focus to the export control, and leaves the project editable.
- Completion, failure, and stale encoder events are isolated to their own export session, so a cancelled export cannot later download a GIF or disrupt a new export.
- The encoder preparation loop yields between source frames, allowing the cancel control to remain responsive for longer animations.

### Verified

- Added browser coverage for the visible progress state, real cancel control, encoder abort, active-frame restoration, ignored stale completion, and a later successful export.
- All twenty browser and module regression tests pass, including a real offline GIF download.

### Completed — Compact top-bar action access

- Kept the established full desktop toolbar unchanged.
- At narrow widths only, replaced hidden horizontal top-bar overflow with a clear More-actions menu containing New, Save, Open, Settings, Help, PNG export, and GIF export.
- The compact menu supports keyboard focus, Escape dismissal, outside-click dismissal, and returns dialog focus to its trigger; it is a safeguard for constrained windows rather than a new primary workflow.

### Verified

- Added browser coverage at 768px for no top-bar horizontal overflow, each compact action’s reachability, Help dialog launch, and Escape dismissal.
- All twenty-one browser and module regression tests pass.

### Next

Close the remaining original-audit usability gaps with Pivot compatibility preserved, beginning with reviewing transport/navigation controls and identifying only changes that improve clarity without changing established shortcuts.

## Phase 1 — Reliability foundation

- Create Frame 1 immediately for every new project.
- Make the active frame authoritative before autosave, project download, playback, duplication, and GIF export.
- Introduce a versioned project format that preserves dimensions, frames, active frame, timing, groups, background asset, and project-level playback settings.
- Migrate version-3 projects and validate malformed or oversized inputs before applying them.
- Replace ad-hoc snapshots with transactional Undo/Redo behavior, including text edits, frame operations, timing, grouping, and deletion.
- Add automated regression coverage for edit → reload, edit → save/open, and edit → export.

## Phase 2 — Core editor interactions

- Separate tools/modes from one-off actions; remove misleading active states.
- Make Space Play/Pause and publish a shortcut reference.
- Make selection behavior consistent for single figures, multi-selection, groups, paste, and deletion.
- Improve timeline transport order, duplication, multi-selection, timing language, and thumbnail fidelity.
- Add truthful save state and clearer export/error feedback.

## Phase 3 — Responsive and accessible interface

- Add desktop, compact-laptop, and tablet layouts; turn the inspector into a drawer at narrow widths.
- Add Fit Stage and reliable panning/zooming; enlarge touch targets and joint hit areas.
- Restore browser zoom and implement semantic controls, keyboard navigation, accessible names, focus states, modal focus trapping, and pressed states.
- Raise contrast and minimum type sizes to an accessible, student-friendly baseline.

## Phase 4 — Product hardening and polish

- Add a first-run tutorial, Help/Shortcuts, project names, and recent-project recovery.
- Bundle dependencies and assets locally; make essential editing and GIF export work offline.
- Remove unsafe imported-data rendering and validate all project data.
- Incrementally extract project state, persistence, command history, rendering, and UI coordination into testable modules.
- Stress-test large projects and complete browser, touch, and keyboard QA.

## Compatibility and verification

- Keep the app static and local-first; no account or backend is required.
- Preserve compatibility with existing version-3 `.json` projects through migration.
- Test at 1440×900, 1366×768, 1024×768, and tablet portrait/landscape.
- Test keyboard-only, touch, reload/save/open/export, malformed-file, offline, and 100+ frame scenarios before each phase is accepted.
