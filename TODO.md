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
  - The file is 3009 lines and owns: main loop, abort handling, liveness/progress checks, request consolidation+validation, arbitration prompt building + bounded compaction, CLI invocation with abort watcher, action processing (end_agent/soft/hard restart), restart-budget refund, ownership enforcement, recovery-tag + worktree mutations, validation runner, finalize/summary, dashboard auto-launch. Each concern has its own invariants, but the single file blocks isolated testing and makes the call graph hard to hold in head.
  - *Suggested split:*
    - `lib/staged-requests.js` — consolidate + validate + read helpers.
    - `lib/arbitration.js` — `buildOrchestratorPrompt`, `buildBoundedArbitrationPrompt`, `callOrchestratorCli`, `truncateMiddle`.
    - `lib/ownership.js` — `checkCompletionOwnership`, `pathPatternMatches`, glob → regex.
    - `lib/validation.js` — `runValidation`, `validationTimeout`, hard cap.
    - `lib/worktree-ops.js` — `captureRecoveryAndReset`, `commitWorktree`, `stageAllChanges`.
    - `lib/progress-tracking.js` — heartbeat grace, escalation, milestones.
    - `lib/finalize.js` — `finalize`, `buildFinalSummary`, terminal launch.
  - Keep `scripts/orchestrator-loop.js` as the entry point + the main while loop. The existing test suite already covers most behaviors by module; the migration is mechanical but unlocks faster iteration.

  ### Staged plan (each stage = one independently shippable commit)

  **Invariant for every stage**
  - Move functions *verbatim* — no signature changes, no inlining cleanups.
  - Re-import the moved names back into `scripts/orchestrator-loop.js` so the in-file call sites are untouched.
  - Keep `module.exports` at the bottom of `orchestrator-loop.js` exporting the same names (now re-exports) so tests at `tests/git-commit-safety.test.js`, `tests/prompt-render.test.js`, `tests/progress-timeout-window.test.js`, `tests/orchestrator-loop-failures.test.js` keep passing without edits.
  - Exit criterion before commit: `node --test tests/` is green and `git diff --stat scripts/orchestrator-loop.js` shows only deletions + the new `require(...)` line. Then commit with `refactor(orchestrator-loop): extract <module>` so each checkpoint is bisectable.
  - If a session is interrupted: discard any uncommitted edits (`git stash` or `git checkout -- .`) and restart the stage — never a half-extracted module.

  **Stage 0 — Baseline (≈10 min)**
  - Run `node --test tests/` once and record the passing baseline (count + duration). Every later stage compares against it.
  - No code changes. Commit nothing. This stage exists so a mid-refactor regression can be unambiguously attributed.

  **Stage 1 — `lib/git-ops.js` (≈45 min, ~70 lines moved)**
  - Move `stageAllChanges`, `stageCompletionChanges`, `commitWorktree`, `runGit`, `gitStdout`, `gitErrorDetails` (lines ~1993–2058). All are module-scope, no closure capture.
  - Touchpoint: `tests/git-commit-safety.test.js` imports `commitWorktree`, `stageAllChanges` from `scripts/orchestrator-loop` — keep the re-export, no test edit.
  - Why first: pure fs/subprocess wrappers, smallest blast radius, exercises the re-export pattern that every later stage will reuse.

  **Stage 2 — `lib/worktree-recovery.js` (≈60 min, ~150 lines moved)**
  - Move `captureRecoveryAndReset` plus its submodule helpers: `inspectNestedGitState`, `collectDeclaredSubmodulePaths`, `readSubmodulePathsFromGitmodules`, `readSubmodulePathsFromConfig`, `parseGitConfigPathValues`, `collectNestedGitPaths`, `walk` (inline helper inside `collectNestedGitPaths`), `gitCleanArgsForNestedGitState`, `normalizeRepoRelativePath`, `pathWithinRepoPath` (lines ~2060–2204).
  - Imports `runGit` / `gitStdout` from the freshly extracted `./lib/git-ops`.
  - `captureRecoveryAndReset` already takes `runId` as a parameter, so no closure refactor needed.
  - Touchpoint: re-export `captureRecoveryAndReset` to keep `orchestrator-loop-failures.test.js` and the submodule survival test (test gap above) working.

  **Stage 3 — `lib/ownership.js` (≈45 min, ~210 lines moved)**
  - Move `checkCompletionOwnership`, `ownershipResult`, `formatOwnershipViolation`, `collectOwnershipChangedFiles`, `resolveOwnershipBaseRef`, `addGitLines`, `pathList`, `matchesAnyPathPattern`, `pathPatternMatches`, `globPatternToRegExp`, `hasGlob`, `normalizeRepoPath`, `isRuntimeCoordSymlink`, `formatOwnershipFileList`, `escapeRegExp`, `toPosixPath` (lines ~2320–2534).
  - Re-export `checkCompletionOwnership`, `collectOwnershipChangedFiles`, `pathPatternMatches` (used by tests).

  **Stage 4 — `lib/staged-requests.js` (≈30 min, ~140 lines moved)**
  - Move `consolidateStagedRequests`, `readStagedRequests`, `stagedRequestContext`, `readAndValidateStagedRequest`, `validateStagedRequest`, `inferAgentFromStagedFile`, `isSafeRequestId`, `isSafeAgentName`, `isIsoTimestamp` plus the constants `SAFE_REQUEST_ID`, `SAFE_AGENT_NAME`, `STAGED_REQUEST_TYPES`, `REQUEST_PRIORITIES` (lines ~1682–1832).
  - Re-export `consolidateStagedRequests` (used by tests + the inner loop).

  **Stage 5 — `lib/validation-control.js` (≈40 min, ~115 lines moved)**
  - Move the validation-runner control surface: `validationTimeout`, `firstPositiveNumber`, `formatValidationTimeout`, `hasValidationCommand`, `formatValidationCommandForLog`, `isValidationRunning`, `readValidationResult`, `missingValidationResultIfStale`, `writeValidationResultFile`, `safeValidationFileSegment`, `processAlive`, `killValidationRunner` (lines ~2205–2319). Also lift `VALIDATION_STATE` and `VALIDATION_HARD_CAP_MINS` constants.
  - Leave `beginCompletionValidation`, `processFinishedValidations`, `handleValidationFailure` in `orchestrator-loop.js` for now — they're `runLoop`-scope closures and belong to Stage 9.

  **Stage 6 — `lib/progress-tracking.js` (≈40 min, ~145 lines moved)**
  - Move `hasPendingProgressTimeoutRequest`, `buildProgressTimeoutRequest`, `progressTimeoutHistory`, `parseIsoMs`, `stampProgressMilestone`, `buildProgressEscalation`, `buildDeterministicProgressInstruction`, `readProgressHeartbeat`, `heartbeatChanged`, `shouldGrantHeartbeatGrace`, `normalizeHeartbeatPhase`, `limitHeartbeatData`, `formatHeartbeatForRequest`, `formatList`, `readDiffSnapshot`, `readDiffHash` plus `HEARTBEAT_GRACE_PHASES` (lines ~1358–1605, plus ~1945–1972).
  - Re-export `progressTimeoutHistory` (used by tests).

  **Stage 7 — `lib/arbitration.js` (≈60 min, ~290 lines moved)**
  - Move `collectWorktreeStates`, `buildBoundedArbitrationPrompt`, `truncateMiddle`, `buildOrchestratorPrompt`, `callOrchestratorCli`, `invokeOrchestratorCli` plus `ARBITRATION_PROMPT_CAP_BYTES` and `RECENT_DECISION_LIMIT` (lines ~2532–2800).
  - `callOrchestratorCli` takes `abortFlagPath` as a parameter — no closure capture, but it does spawn a child and reads/writes the abort flag, so pair with an integration smoke check that the abort-while-arbitrating path still triggers (the inspect-live test exercises this).
  - Re-export `buildOrchestratorPrompt`, `buildBoundedArbitrationPrompt`, `ARBITRATION_PROMPT_CAP_BYTES` (used by `prompt-render.test.js`).

  **Stage 8 — `lib/finalize.js` (≈30 min, ~150 lines moved)**
  - Move `finalize`, `runSummaryTerminal`, `buildFinalSummary`, `latestReviewRequestForAgent`, `truncate` (lines ~2835–end).
  - Also move the stalled-flag helpers (`writeStalledFlag`, `clearStalledFlag`) into the same file or a sibling `lib/stalled-flag.js` — they're small and only the main loop calls them.
  - Re-export `buildFinalSummary` (used by `orchestrator-loop-failures.test.js`).

  **Stage 9 — `runLoop` inner helpers (stretch, ≈90 min)**
  - This is the only stage that changes signatures: `processActions`, `processApprovals`, `beginCompletionValidation`, `processFinishedValidations`, `completeValidatedEndAgent`, `handleValidationFailure`, `bumpRestartAndRespawn`, `resetMilestonesOnWaitResolutions`, `appendDecisionRecords`, the completion-request helpers, and the rejection helpers currently close over `config.coordDir`, `runId`, `agentProgress`, `consecutiveCliFailures`.
  - Refactor each to accept an explicit `ctx = { coordDir, runId, log, paths, parsedConfig }` argument, then move to `lib/actions.js` (restart/end-agent flow) and `lib/approvals.js` (request resolution + audit append).
  - Land in two sub-commits — `lib/approvals.js` first (the lower-coupling half), then `lib/actions.js`. If session ends after the first sub-commit, the repo is still shippable.
  - Skip if budget runs out: every stage 1–8 is independently valuable, and the file is already down ~1500 lines by then.

  **Stage 10 — Drop the re-export shim (≈20 min, optional, after a soak period)**
  - Once stages 1–9 land and have lived on `main` for a release cycle, update the four test files to import from `scripts/lib/*` directly and delete the now-empty `module.exports` block in `orchestrator-loop.js`.
  - Defer; not a blocker for shipping the refactor.

  **Order rationale**
  - Stages 1–3 extract pure helpers with zero closure capture; they prove the re-export pattern works without touching the loop's invariants.
  - Stages 4–8 are progressively larger but still module-scope, each protected by an existing test (`staged-request-quarantine`, `process-approvals-atomic`, `progress-timeout-window`, `prompt-render`, `orchestrator-loop-failures`).
  - Stage 9 is the only one that risks regressing the action pipeline — gated behind the eight passing earlier stages so a bisect points at exactly the closure conversion if something breaks.

## Test gaps

- [x] **[C2] Crash mid-`processApprovals`**: write a test that injects a fault between `appendDecisionRecords` and `updateJSONL`, then reboots the loop and confirms no request is re-arbitrated.
- [x] **[C2] Concurrent lock acquire**: spawn N parallel `acquireLock` callers against the same file and assert no caller sees a half-formed lock (no missing pid file, no premature stale-cleanup).
- [x] **[C2] Per-cycle subprocess count**: assert that with 10 running agents, one main-loop tick spawns at most one `ps` and at most one `git` per agent (regression for the perf fix above).
- [x] **[C2] Coord symlink subtree ownership**: simulate a worker writing `coord/requests/foo.json` via the symlink and assert ownership check passes.
- [x] **[C2] Submodule survives `captureRecoveryAndReset`**: stage a `.gitmodules` entry in a worker worktree, trigger a hard restart, and assert the submodule path is preserved (or the hard restart refuses).
