# Autosave recovery change log

## Release authorization — 2026-09-09

The user approved publishing the reviewed fix together with the experimental
STK importer. Earlier no-push notes below describe the completed local review
stage, before this release authorization.

Date: 2026-09-09

## Scope

Repair the IndexedDB autosave status and ordering exposed by the project-name recovery failure. Existing STK importer changes remain untouched.

Builder: Luna xhigh. Reviewer: parent agent. Accepted locally after the final
independent checks below. No commit, push or deployment was performed.

## Baseline evidence

The pre-fix autosave probe queued `Untitled animation`, then `Rocket rehearsal`, while the UI already reported `Saved`. The observed order was:

`request-success Untitled` → `status Saved (pending Rocket)` → `transaction-complete Untitled` → `request-success Rocket` → `status Saved` → `transaction-complete Rocket`.

This demonstrated two concrete defects: an IndexedDB request-success callback is earlier than durable transaction completion, and each completed queue item could report `Saved` while a newer payload was still pending.

## Accepted changes

1. `src/storage.js`: resolve a request only on `transaction.oncomplete`, and reject once on request, transaction, or abort errors. Reads and writes now share the same durability boundary.
2. `index.html`: show `Saving` immediately when a serialized payload is queued, and report `Saved` only after the queue is empty and its last transaction has completed.
3. `index.html`: add a monotonically increasing save revision and retain a serialization-failure revision so an older in-flight write cannot overwrite a newer `Save failed` state with `Saved`. A later successful retry clears that failure marker.
4. `index.html`: give `Saving` an accurate storage-indicator tooltip.
5. `tests/storage.test.mjs`: add a deterministic delayed-transaction regression. Its fake IndexedDB has explicit request-success, transaction-complete, and transaction-abort gates, asserting the storage promise is still pending after request success; it also asserts an aborted transaction rejects and does not replace the prior durable value.
6. `tests/e2e/editor.spec.js`: add a browser regression with explicitly gated
   writes for queued snapshots, failures, retries and stale completion after a
   serialization error. Synchronize the existing first-pose test on `Saved`
   before reload, keeping its exact pose assertion unchanged.
7. Bound the fake-storage test's microtask wait to 100 turns so a regression
   fails instead of hanging the test process.

## Refused / unchanged

- Existing recovery and pose assertions were retained exactly; the pose test now awaits the visible `Saved` state before reloading so it does not treat an unfinished asynchronous save as durable.
- No startup lifecycle changes were made: the reviewed failure was reproduced and fixed at the autosave durability boundary, while an independent startup race was not deterministically reproduced in this scoped change.
- A timer-only fake transaction (5 ms request / 40 ms completion) was refused because scheduler timing can make the pending assertion flaky; the final regression uses explicit completion/abort gates and microtask flushing.
- The initial browser regression's 100 ms write delay was replaced by explicit
  gates, which also verify the interval between older and latest writes.
- An unused pending-save revision field was removed during review; only the
  revision/error tracking needed to preserve failure status remains.
- No changes were made to project/pose serialization, STK importer behavior, or the running preview server.

## Follow-up correction

An interim full run passed all 51 then-existing tests in 15.0 seconds. After
adding the new browser regression, the expanded run was `51/52 passed` in
21.1 seconds; the remaining failure was the pre-existing first-pose test
reloading immediately after an unawaited `app.saveLocal()`, so it observed the
old `{x: 400, y: 300}` draft instead of the intended `{x: 123, y: 234}` pose.
The accepted correction is test synchronization only: wait for the user-visible
`Saved` state before reload. This keeps the exact pose assertion and does not
add retries or relax correctness. The final rerun passed all 52 tests.

## Measurements after the fix

- `node --test tests/storage.test.mjs`: 1 passed, 0 failed.
- `npx playwright test tests/e2e/editor.spec.js --grep "reports Saving until" --workers=1`: 1 passed, 0 failed. Explicit write gates kept the UI at `Saving` while an older snapshot completed and while the latest payload remained pending; the test also covered visible write failure, retry, serialization failure, and later recovery.
- Final independent `npx playwright test --workers=1`: **52 passed, 0 failed,
  20.7 seconds**, including original name recovery, synchronized pose recovery,
  large IndexedDB projects, the new queued-save regression and STK imports.
- Final independent `node --test tests/*.test.mjs`: **10 passed, 0 failed,
  191.2 ms**.
- Real IndexedDB probe: immediate state was `Saving`, with `localSaveRunning=true` and a pending payload; event order became `request-success Untitled` → `transaction-complete Untitled` → `request-success Rocket rehearsal` → `transaction-complete Rocket rehearsal` → `Saved` with no pending payload. Persisted project name was `Rocket rehearsal`; persisted pose x was `123`.
- Independent explicit-gate browser review: **7/7 checks passed**, covering
  pending/queued saves, exact persisted name and pose, write failure, retry,
  serialization failure protected from stale completion, and successful recovery.
- Repeated reload review: **30/30** fresh browser contexts recovered the latest
  name and pose after `Saved`. A pre-fix timing-dependent run also passed 10/10;
  the gated tests and observed event ordering, not random reload success alone,
  establish the fix.
- Real IndexedDB abort check: request success fired, then the transaction was
  explicitly aborted; the write promise rejected and the previous project JSON
  remained exactly intact.
- Final `git diff --check`: passed. No animation geometry or file format changed.

## Reviewer artifacts and limits

Independent scripts are in
`/Users/crayner/.codex/visualizations/2026/08/09/019fe8b4-4eba-72c2-bd2d-e2ade23da76f/`:
`review-autosave-order.mjs`, `review-autosave-delayed.mjs`,
`review-autosave-reload.mjs`, and `review-autosave-abort.mjs`.
The reviewer finalized this measured-results record after Luna's implementation.
Reloading or closing a tab while it still says `Saving` is not a completed-save
guarantee; no unload-time synchronous cache or new startup lifecycle was added.
