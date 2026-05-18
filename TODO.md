# TODO

Each item is tagged with a complexity rating:

- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` (OpenCabinet rebrand, per-run cost tracking, native Windows support, frontend UI dashboard) are not duplicated here.

---

## High (reliability, observability, user trust)

- **[C2] Pre-check for stale agent branches in `launch-all.js`**
  - `scripts/launch-all.js:101-114` calls `git worktree add -b <agentName>` which fails mid-iteration when a stale branch from a prior aborted run still exists. Rollback then leaves a half-spawned run.
  - *Fix:* Before the spawn loop, scan `git branch --list` for every agent name. Either reuse with `-B`, refuse with a clear "stale branch present; run `git branch -D <agent>` or use --resume", or auto-clean if the branch points at no existing worktree.

- **[C2] Add a `launch.lock` mutex for `launch-all.js`**
  - Today only the loop holds `orchestrator.instance.lock`. Two simultaneous `launch-all.js` invocations race on `agents.json`, both spawn workers, and one set becomes orphaned (no recorded PID, no supervision).
  - *Fix:* Acquire `coord/launch.lock` via the existing `acquireLock` helper for the duration of worktree-add + spawn. Refuse a second launch with a clear message and instructions to remove the lock if it's truly stale.

- **[C2] Bound arbitration prompt size**
  - `scripts/orchestrator-loop.js:1662-1717` serializes every pending request with full 50-line log tail and diff snapshot. A run with multiple stalled agents can drift toward 100 KB+ prompts that silently degrade smaller-context arbitration CLIs.
  - *Fix:* Cap per-request payload (last 20 lines + `git diff --stat` only) once the assembled prompt exceeds ~32 KB. Or chunk arbitration calls per agent. Log when a cap is hit.

- **[C2] Stream-tail worker logs instead of re-reading the whole file**
  - `scripts/orchestrator-loop.js:1179`-ish (`readTail`) and `scripts/dashboard.js:92-107` both `readFileSync` the entire log to take the last N lines. With chatty stream-json workers this can become hundreds of MB on long runs.
  - *Fix:* Implement a seek-from-end tail helper (read the last ~64 KB, split, return the trailing N lines). Use it everywhere and cache per-agent read offsets in the dashboard. Add a configurable per-log size cap with rotation (`.log` → `.log.1`).

- **[C2] Add a safeKill fallback when `pidMatchesCli` keeps refusing**
  - `scripts/lib/process.js:6-34` skips signalling if the cmdline substring doesn't match. CLIs that set `process.title` at runtime can drift; the loop then waits forever after liveness timeout.
  - *Fix:* Record the actual cmdline at spawn time (from `ps`) and compare against that instead of the template basename. As a last-resort fallback, allow signalling if `events.jsonl` shows we are the one who spawned the PID and N consecutive checks have refused.

- **[C2] Window `progressTimeoutHistory` to consecutive timeouts since the last code change**
  - `scripts/orchestrator-loop.js:836-843` counts every `progress_timeout` request ever filed for an agent. After a soft_restart succeeds and the agent works cleanly for hours, a fresh stall is immediately escalated to `hard_restart_candidate` instead of `first_timeout`.
  - *Fix:* Track timeouts since the last observed code change (or since the last successful arbitration `wait` resolution). Reset on `resume-agent.js` runs.

## Medium (UX gaps, missing safety nets)

- **[C2] Add a `run_id` to events, decisions, and recovery tags**
  - `coord/decisions.jsonl`, `coord/events.jsonl`, and recovery tags persist across `--resume` (and survive non-`--force` reruns), so stale arbitration history bleeds into new runs via `readRecentDecisions`.
  - *Fix:* Stamp every event/decision with a `run_id` set at loop startup (ISO timestamp or short ulid). Skip prior `run_id`s in `readRecentDecisions`. Also unblocks per-run cost tracking on the Roadmap.

- **[C2] Detect a live loop even when `instance.lock` is missing**
  - `scripts/lib/locking.js:10-33` only checks the lock and its recorded PID. If the user deletes a "stale" lock while a loop is in fact still running, a second loop double-arbitrates every request.
  - *Fix:* Before acquiring, `ps`-scan for an `orchestrator-loop.js --coord <same path>` process. Refuse with a strong message that names the running PID.

- **[C2] Treat `'?'` PIDs from launch as spawn failures**
  - `scripts/launch-all.js:80-186` already checks `spawn-agent.js` exit code, but a PID never captured (panic between `child.unref()` and the PID print line) still gets treated as success.
  - *Fix:* Require a real PID before continuing; if missing, rollback the iteration.

- **[C2] Don't consume restart budget on infrastructure spawn failures**
  - `scripts/orchestrator-loop.js:561-607` (`bumpRestartAndRespawn`) increments `restart_count` and just logs when respawn fails. The next cycle sees a corrupt state and transitions the agent to `exited`.
  - *Fix:* On respawn failure, transition directly to `needs_attention` with a `respawn_failed` rationale (or decrement the restart count). Don't punish the agent for an EAGAIN/EAGAIN-class hiccup.

## Low (cleanup, doc drift)

## Test gaps

- **[C2] Test: two concurrent `launch-all.js` invocations are refused** (paired with the High `launch.lock` item). `tests/launch-all.test.js` has nothing today.
