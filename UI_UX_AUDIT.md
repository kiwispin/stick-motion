# StickMotion UI/UX Audit

## Executive verdict

StickMotion is a strong classroom prototype with a credible visual foundation. It already feels more intentional than many educational animation tools: the canvas is dominant, the timeline is recognizable, the dark workspace is coherent, and the direct manipulation is satisfying.

It is not yet a commercial-grade product. The largest gap is confidence: students cannot always trust that their latest work has been saved, exported, or included in Undo. Responsive behavior, accessibility, touch support, and onboarding also remain prototype-level.

| Area | Assessment |
| --- | ---: |
| Visual direction | 7.5/10 |
| Core animation capability | 7/10 |
| Learnability | 5/10 |
| Interaction consistency | 4.5/10 |
| Data safety and recovery | 3/10 |
| Responsive and touch UX | 3/10 |
| Accessibility | 2/10 |
| Commercial readiness | 3.5/10 |

Overall: approximately **5/10 today**, with a plausible path to an excellent product.

## What is working well

- Direct, account-free creation and local-first privacy.
- A focused white stage within a coherent dark workspace.
- Appropriate direct manipulation through pivots.
- A consistent visual language: spacing, rounded controls, blue primary actions, and compact tool chrome.
- Meaningful creative depth: timeline, onion skinning, interpolation, groups, a model library, custom figures, text, backgrounds, and PNG/GIF export.
- A default figure that avoids an empty-canvas problem.

Keep these qualities during the redesign.

## Critical findings

### P0 — Latest work can be lost

The app stores a live editable `figures` collection separately from stored `frames`, but does not synchronize them consistently. A reproduced sequence—edit a framed figure, save locally, then reload—restored the older frame rather than the latest pose. Downloaded projects had the same problem, and GIF export renders stored frames without first committing the active edit.

Fix this first: make Frame 1 exist immediately, establish one authoritative project state, commit the active frame before every persist/export/playback operation, and protect it with round-trip regression tests.

### P0 — A new project claims to have Frame 1 while containing no frame

A new project creates a figure but zero frames. Saving immediately produces a project without frame content, while the UI says “Frame 1”. Play and GIF export cannot work until the student adds a frame manually.

### P0 — Undo is inconsistent

Typing into a text figure does not create an appropriate history entry. Undo after editing text can remove the text object instead of restoring its earlier copy. Frame creation and several settings also bypass Undo.

### P0 — Project persistence is incomplete

The project format omits the live working state, background image, current frame, and several meaningful settings. Inputs are not validated or bounded, so malformed projects and excessive canvas sizes can cause unreliable behavior.

## Interaction and usability

- The Select toolbar button is a no-op while Add Stickman is styled as a persistent active mode. Clearly separate actions from modes.
- Space adds a frame while stopped and stops playback while playing. This matches the familiar Pivot Animator workflow and should remain; teach it prominently in onboarding and Help so students understand the intentional frame-creation shortcut.
- The initial experience does not explain handle colors, timeline creation, or tweening. Add a short dismissible first-run guide and a Help/Shortcuts panel.
- Transport order should be First, Previous, Play/Pause, Next, Last.
- Multi-selection is only partially supported: several commands operate on one selected figure, while keyboard deletion can miss a multi-selection.
- Timeline thumbnails omit text/speech detail and backgrounds, and rebuilding all thumbnails while dragging the duration slider risks jank.

## Responsive and touch audit

The editor has no responsive breakpoints. At 1024×768 controls crowd the workspace; at 768×1024 the top bar and playback controls clip, the fixed inspector consumes excessive space, and the whole stage cannot be viewed at once.

Recommended layout strategy:

- Desktop at 1200px and above: retain the three-column editor.
- Compact laptop at 800–1199px: collapsible inspector and compact transport.
- Below 800px: inspector becomes a drawer, top actions collapse into menus, and playback uses two rows.
- Add Fit Stage, 100%, Fit Width, Fit Selection, predictable panning, and touch-sized handles.

## Accessibility audit

The current build is unlikely to meet WCAG 2.2 AA.

- Pinch zoom is disabled with `user-scalable=no`.
- Many controls are smaller than 24px, and many are too close together for touch.
- Secondary text contrast is approximately 2.25–2.47:1 on its common backgrounds, below the 4.5:1 requirement for normal text.
- Clickable cards, groups, swatches, and frames are non-semantic `div` elements.
- Toggles lack exposed pressed state; modals lack dialog semantics and focus management.
- Inputs lack labels; color swatches lack accessible names; canvas editing has no keyboard alternative.
- Focus treatment is weak and much of the UI uses 10–11px text.

Reference: [W3C Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), [W3C Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text), and [W3C Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow.html).

## Feedback, offline use, and security

- The Storage badge is static and does not indicate whether the project really saved.
- Export has no progress, cancellation, or useful error message.
- GIF export depends on a network-fetched worker; fonts and runtime Tailwind are also remote dependencies. Bundle required assets locally for classroom reliability.
- Timeline regeneration and localStorage serialization can become expensive in larger projects.
- Imported project values are inserted with `innerHTML`; replace this with `textContent` and event listeners, then validate project data.

## Recommended delivery order

1. **Reliability:** Frame 1, active-frame synchronization, robust save/open/export, project validation, and consistent Undo.
2. **Core UX:** action-versus-mode cleanup, standard playback, selection behavior, timeline clarity, and truthful save status.
3. **Responsive and accessible UI:** compact/tablet layouts, touch interactions, semantic controls, dialogs, contrast, and browser zoom.
4. **Premium polish:** onboarding, Help, project names, offline packaging, designed library previews, stress testing, and modularization.

## Bottom line

StickMotion has a genuinely good product inside it. The creative capability and visual foundation justify investment. Correctness must come first: do not market the current build as fully reliable until active-frame data loss is fixed. The next largest gains will come from responsive layout, touch-first selection, accessibility, and onboarding—not a cosmetic reskin.
