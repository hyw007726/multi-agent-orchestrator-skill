# TODO

Each item is tagged with a complexity rating:

- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` (OpenCabinet rebrand, per-run cost tracking, native Windows support, frontend UI dashboard) are not duplicated here.

---

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
