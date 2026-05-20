# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)


## Medium (UX gaps, missing safety nets)

## Architecture / design

- **[C3] Split `scripts/orchestrator-loop.js` into focused modules**
  - The file is 2365 lines and owns: main loop, abort handling, liveness/progress checks, request consolidation+validation, arbitration prompt building + bounded compaction, CLI invocation with abort watcher, action processing (end_agent/soft/hard restart), restart-budget refund, ownership enforcement, recovery-tag + worktree mutations, validation runner, finalize/summary, dashboard auto-launch. Each concern has its own invariants, but the single file blocks isolated testing and makes the call graph hard to hold in head.
  - *Suggested split:*
    - `lib/staged-requests.js` — consolidate + validate + read helpers.
    - `lib/arbitration.js` — `buildOrchestratorPrompt`, `buildBoundedArbitrationPrompt`, `callOrchestratorCli`, `truncateMiddle`.
    - `lib/ownership.js` — `checkCompletionOwnership`, `pathPatternMatches`, glob → regex.
    - `lib/validation.js` — `runValidation`, `validationTimeout`, hard cap.
    - `lib/worktree-ops.js` — `captureRecoveryAndReset`, `commitWorktree`, `stageAllChanges`.
    - `lib/progress-tracking.js` — heartbeat grace, escalation, milestones.
    - `lib/finalize.js` — `finalize`, `buildFinalSummary`, terminal launch.
  - Keep `scripts/orchestrator-loop.js` as the entry point + the main while loop. The existing test suite already covers most behaviors by module; the migration is mechanical but unlocks faster iteration.

## Test gaps

- [x] **[C2] Crash mid-`processApprovals`**: write a test that injects a fault between `appendDecisionRecords` and `updateJSONL`, then reboots the loop and confirms no request is re-arbitrated.
- [x] **[C2] Concurrent lock acquire**: spawn N parallel `acquireLock` callers against the same file and assert no caller sees a half-formed lock (no missing pid file, no premature stale-cleanup).
- [x] **[C2] Per-cycle subprocess count**: assert that with 10 running agents, one main-loop tick spawns at most one `ps` and at most one `git` per agent (regression for the perf fix above).
- [x] **[C2] Coord symlink subtree ownership**: simulate a worker writing `coord/requests/foo.json` via the symlink and assert ownership check passes.
- [x] **[C2] Submodule survives `captureRecoveryAndReset`**: stage a `.gitmodules` entry in a worker worktree, trigger a hard restart, and assert the submodule path is preserved (or the hard restart refuses).
