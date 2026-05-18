# TODO

Each item is tagged with a complexity rating:

- **[C1]** - small surgical change, single file, clear logic, low risk.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` (OpenCabinet rebrand, per-run cost tracking, native Windows support, frontend UI dashboard) are not duplicated here.

## Top 3 to fix first

1. **Loop log path ignores `--coord`** — silent observability loss for any non-default coord directory.
2. **Add `launch.lock` + `run_id`** — prevents double-launch orphaning workers and stops stale arbitration history from bleeding into resumed runs.
3. **Stop destructively overwriting `agent.task` on restart** — the dashboard and `review-summary.txt` currently misrepresent every agent that ever restarted.

---

## Critical (correctness, data loss, security)

- **[C1] Resolve loop log path against `--coord`**
  - `scripts/orchestrator-loop.js:729` initializes `logFile: "coord/orchestrator.log"` as a literal and never derives it from `config.coordDir`. With a non-default `--coord` the loop writes to the wrong directory or fails with ENOENT.
  - *Fix:* After `--coord` parsing, set `config.logFile = path.join(config.coordDir, "orchestrator.log")`. Add a regression test that launches with `--coord ./other-coord` and asserts the log lands there.

- **[C1] Lock `appendEvent` the same way `appendJSONL` is locked**
  - `scripts/lib/events.js:57` calls `fs.appendFileSync` with no lock. Records over PIPE_BUF (4 KB) from `orchestrator-loop.js` and `spawn-agent.js` can interleave during restart bursts and corrupt `events.jsonl`.
  - *Fix:* Route `appendEvent` through `appendJSONL` in `scripts/lib/locking.js`. Mirror the same `.lock` dir convention.

- **[C1] Make `readJSONL` skip malformed lines instead of crashing**
  - `scripts/lib/locking.js:99-102` does `.map((l) => JSON.parse(l))` with no try/catch. One bad line in `requests.jsonl` wedges the loop forever — every cycle throws and falls into the generic error-sleep path.
  - *Fix:* Wrap each parse in try/catch and log+skip (match `updateJSONL`'s existing policy). Optionally quarantine offending lines to `<file>.corrupt`.

- **[C1] Make recovery-tag creation collision-safe and roll back the RECOVERY commit on failure**
  - `scripts/orchestrator-loop.js:1362-1363` tags `recovery/<agent>/<iso-ms>` without `-f` and without a per-attempt suffix. The RECOVERY commit is already on the branch by the time tagging runs; if tagging fails, the commit becomes a permanent, unlabeled pollutant that later gets merged into main.
  - *Fix:* Append a short random suffix (or restart-counter) to the tag name. If `git tag` fails, `git reset --hard HEAD~1` to discard the RECOVERY commit before bailing.

- **[C1] Preserve `agent.task` as the immutable description; store restart instructions separately**
  - `scripts/orchestrator-loop.js:462, 476` reassigns `agents[name].task = instruction` (or `"Exhausted N restart attempts…"`). `buildFinalSummary` and `dashboard.js` then render the latest restart instruction as if it were the original task.
  - *Fix:* Introduce `agent.last_instruction` for the rotating restart payload. Render `tasks[name].description` from `context.json` for the dashboard and review-summary; keep the current instruction as a secondary line.

- **[C2] Add a `timeout` to `runValidation`**
  - `scripts/orchestrator-loop.js:1387-1414` calls `spawnSync` with `shell:true` and no timeout, inheriting the full loop environment. A hanging test suite blocks the loop's main cycle and starves every other agent.
  - *Fix:* Pass `timeout: (agent.validation_timeout_mins ?? agent.timeout_mins) * 60_000`. Treat timeout as `passed: false` with a clear failure log. Document the shell-form trust requirement in `references/schemas.md`.

- **[C2] Resolve `end_agent` request approval inside the same write that signals the worker**
  - `scripts/orchestrator-loop.js:346-407, 268-269` signals the worker, then later applies approvals in `processApprovals`. A crash in between leaves a completed agent with an unresolved `review_request` forever.
  - *Fix:* Inside the `updateJSONL` callback that resolves `end_agent`, mark the originating request approved before sending SIGTERM.

## High (reliability, observability, user trust)

- **[C1] Append (don't overwrite) `orchestrator-loop.out`**
  - `scripts/launch-all.js:188-196` uses `>` to redirect the backgrounded loop's stdout, wiping the previous run's startup diagnostics. When the loop dies before opening its own log (config error, missing PATH entry, etc.), there is no trace anywhere.
  - *Fix:* Switch to `>>`, or write to `coord/loop-runs/<timestamp>.out`. Keep the last N runs.

- **[C2] Pre-check for stale agent branches in `launch-all.js`**
  - `scripts/launch-all.js:101-114` calls `git worktree add -b <agentName>` which fails mid-iteration when a stale branch from a prior aborted run still exists. Rollback then leaves a half-spawned run.
  - *Fix:* Before the spawn loop, scan `git branch --list` for every agent name. Either reuse with `-B`, refuse with a clear "stale branch present; run `git branch -D <agent>` or use --resume", or auto-clean if the branch points at no existing worktree.

- **[C2] Add a `launch.lock` mutex for `launch-all.js`**
  - Today only the loop holds `orchestrator.instance.lock`. Two simultaneous `launch-all.js` invocations race on `agents.json`, both spawn workers, and one set becomes orphaned (no recorded PID, no supervision).
  - *Fix:* Acquire `coord/launch.lock` via the existing `acquireLock` helper for the duration of worktree-add + spawn. Refuse a second launch with a clear message and instructions to remove the lock if it's truly stale.

- **[C2] Bound arbitration prompt size**
  - `scripts/orchestrator-loop.js:1662-1717` serializes every pending request with full 50-line log tail and diff snapshot. A run with multiple stalled agents can drift toward 100 KB+ prompts that silently degrade smaller-context arbitration CLIs.
  - *Fix:* Cap per-request payload (last 20 lines + `git diff --stat` only) once the assembled prompt exceeds ~32 KB. Or chunk arbitration calls per agent. Log when a cap is hit.

- **[C1] Have `spawn-agent.js` emit a structured result line**
  - `scripts/launch-all.js:176-185` regex-parses human-readable stdout (`PID: \d+`, etc.) from `spawn-agent.js`. Any wording change silently breaks PID capture, which silently disables rollback (PID becomes `'?'`).
  - *Fix:* Emit a final line like `__SPAWN_RESULT__ {"pid":1234,"logFile":"…","templateMode":"argv"}` and parse that single JSON object. Treat a missing/`'?'` PID as a spawn failure and rollback.

- **[C2] Stream-tail worker logs instead of re-reading the whole file**
  - `scripts/orchestrator-loop.js:1179`-ish (`readTail`) and `scripts/dashboard.js:92-107` both `readFileSync` the entire log to take the last N lines. With chatty stream-json workers this can become hundreds of MB on long runs.
  - *Fix:* Implement a seek-from-end tail helper (read the last ~64 KB, split, return the trailing N lines). Use it everywhere and cache per-agent read offsets in the dashboard. Add a configurable per-log size cap with rotation (`.log` → `.log.1`).

- **[C1] Treat unparseable liveness timestamps as stale, not fresh**
  - `scripts/orchestrator-loop.js:1278-1282` (`readAgentCurrentStartMs`) falls back to `Date.now()` when all stored timestamps are missing or malformed, effectively resetting the liveness clock every cycle and making the agent immortal.
  - *Fix:* When parsing fails, log a warning and treat the agent as in `needs_attention` rather than newly-started.

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

- **[C1] Refuse to spawn when `allowed_paths` resolves to `(unspecified)`**
  - `scripts/lib/prompt-render.js:22` substitutes `(unspecified)` for empty/missing values. `validate-context.js` already requires non-empty `allowed_paths` for context.json, but restart-prompt rendering has no guard and any in-flight edit to context.json can sneak through.
  - *Fix:* In `spawn-agent.js`, hard-fail if the rendered prompt contains `ALLOWED PATHS: (unspecified)`. Same for restart prompts.

- **[C2] Detect a live loop even when `instance.lock` is missing**
  - `scripts/lib/locking.js:10-33` only checks the lock and its recorded PID. If the user deletes a "stale" lock while a loop is in fact still running, a second loop double-arbitrates every request.
  - *Fix:* Before acquiring, `ps`-scan for an `orchestrator-loop.js --coord <same path>` process. Refuse with a strong message that names the running PID.

- **[C1] Race the `abort.flag` check against in-flight arbitration calls**
  - `scripts/orchestrator-loop.js:75-94` checks the abort flag once per loop iteration. While a `callOrchestratorCli` call is in flight (default 120 s), Ctrl+C feels unresponsive.
  - *Fix:* `fs.watch` the abort flag; on change, cancel the in-flight CLI subprocess so the abort path runs promptly. Alternatively, shorten the default arbitration timeout to ~30 s and surface a "waiting on CLI" hint in the dashboard.

- **[C2] Treat `'?'` PIDs from launch as spawn failures**
  - `scripts/launch-all.js:80-186` already checks `spawn-agent.js` exit code, but a PID never captured (panic between `child.unref()` and the PID print line) still gets treated as success.
  - *Fix:* Require a real PID before continuing; if missing, rollback the iteration.

- **[C2] Don't consume restart budget on infrastructure spawn failures**
  - `scripts/orchestrator-loop.js:561-607` (`bumpRestartAndRespawn`) increments `restart_count` and just logs when respawn fails. The next cycle sees a corrupt state and transitions the agent to `exited`.
  - *Fix:* On respawn failure, transition directly to `needs_attention` with a `respawn_failed` rationale (or decrement the restart count). Don't punish the agent for an EAGAIN/EAGAIN-class hiccup.

- **[C1] Add a `materialized_at` timestamp**
  - `scripts/materialize-plan.js:130` preserves the original `created_at`, so after multiple plan iterations there is no way to tell when the current decomposition was decided.
  - *Fix:* Add a top-level `materialized_at` field, set on every `materialize-plan.js` and `prepare-run.js --approve-draft` run.

- **[C1] Emit a deprecation warning when `claude_failure_threshold` is set**
  - `scripts/lib/config.js:153-162` silently honors the deprecated alias.
  - *Fix:* `loadConfig` should print a one-line stderr warning when the deprecated key appears in user config, with the replacement name.

## Low (cleanup, doc drift)

- **[C1] Document or remove `spawn-agent.js`'s `--` passthrough**
  - `scripts/spawn-agent.js:181-184` appends arbitrary post-`--` args to the CLI template. Undocumented; either a power-user feature or an unaudited extension surface.

- **[C1] Make `extractJsonObject` try end-of-output first**
  - `scripts/lib/provider-output.js:94-129` walks every `{...}` substring and tries `JSON.parse` on each. Slow on verbose stream-json. Try last-`{`-to-last-`}` first, fall back to the full walk.

- **[C1] Note in `references/schemas.md` that `{WORKER_CONCISION_PROMPT}` is rendered by `prompt-render.js`**
  - `references/worker-prompt-template.md:5` reads as a caller-substitutable placeholder but is actually provided by the renderer. Clarify the placeholder grammar table.

## Test gaps

- **[C2] Test: two concurrent `launch-all.js` invocations are refused** (paired with the High `launch.lock` item). `tests/launch-all.test.js` has nothing today.
- **[C1] Test: mixed-batch malformed staged request quarantine.** Drop one `{notJson` file into `coord/requests/` alongside two valid ones; assert the malformed one ends up in `coord/requests/malformed/` with a sibling `.error.txt` and the valid ones still consolidate.
- **[C1] Test: loop survives N consecutive non-JSON arbitration responses without leaking pending state, and the stalled flag fires/clears around `orchestrator_failure_threshold`.** `tests/orchestrator-loop-failures.test.js` only exercises this indirectly.
- **[C1] Test: PID capture from `spawn-agent.js`.** Once `__SPAWN_RESULT__` exists, assert `launch-all.js` parses it and treats a missing PID as failure.
