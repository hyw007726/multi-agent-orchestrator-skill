# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

## Top 5 to fix first

Pointers into the detailed entries below; full context and C-tag are on the body items.

1. **[C2] `runValidation` blocks the entire loop for up to 30 minutes** — every other agent goes unsupervised while a single agent's tests run. (Critical → "`runValidation` can freeze the orchestrator")
2. ~~**[C2] `processApprovals` is not crash-atomic**~~ — _fixed: flip-then-audit ordering in `processApprovals`._
3. ~~**[C2] Per-cycle `ps`/`git` subprocess storm**~~ — _fixed: single `ps -eo` per tick + `cmdMap`; `readDiffHash` (1 git/agent) replaces `readDiffSnapshot` for change-detection._
4. ~~**[C2] `acquireLock` race between `mkdir` and PID-file write**~~ — _fixed: stage-and-rename in `acquireLock`, atomic release._
5. ~~**[C2] Worker-coord symlink failures are swallowed**~~ — _fixed: `ensureCoordSymlink` now exits non-zero with errno + workaround instructions._

---

## Critical (correctness, data loss, security)

- **[C2] `runValidation` can freeze the orchestrator for `VALIDATION_HARD_CAP_MINS` (30 min)**
  - `scripts/orchestrator-loop.js:1616` calls `spawnSync` synchronously inside the main loop. While a worker's test suite runs, every other agent's liveness check, progress timeout, and arbitration is paused; abort flag detection is also delayed.
  - *Fix:* Run validation asynchronously, tracked by an `agent.validation` state field (idle / running / passed / failed). Keep the per-agent serialization, but let the main tick continue supervising peers. The hard cap can drop because the main loop is no longer at risk.

- **[C2] `updateJSONL` permanently drops malformed lines on rewrite**
  - `scripts/lib/locking.js:195-203` reads, filters out unparseable lines (with a `console.error`), and then writes the parsed array back. The malformed line is gone forever after the next mutation. If a corrupted line carried a pending request or decision, the audit log silently loses it.
  - *Fix:* Before rewriting, append every dropped line verbatim to `<file>.malformed` (or quarantine via rename). The current `consolidateStagedRequests` policy for staging files is the right pattern — mirror it for the canonical JSONL writers.

- **[C2] `spawn-agent.js` has a window between `child.spawn` and the `agents.json` write where the worker is unmanaged**
  - `scripts/spawn-agent.js` spawns the detached child, writes the log marker, prints `__SPAWN_RESULT__`, and only then calls `updateJSON(agentsFile, …)`. A crash (EAGAIN, EPIPE on stdout) between the spawn and the JSON write leaves a worker running with no registry entry; `launch-all.js`'s `recoverOrphanForRollback` looks in `agents.json` and finds nothing.
  - *Fix:* Write a minimal `{ pid, cli, started_at, status: "spawning" }` to `agents.json` immediately after `child.unref()`, before any stdout write. Promote to `running` once the marker/templateMode is committed. The orphan-recovery path then has a stable hook.

- **[C2] `captureRecoveryAndReset` destroys nested git state**
  - `scripts/orchestrator-loop.js:1601-1604`: `git reset --hard <head>` followed by `git clean -fd` deletes anything not tracked, including nested `.git` directories and submodule worktrees that a worker may have introduced. Once gone, they cannot be recovered from the recovery tag (only the parent commit's blobs were captured).
  - *Fix:* Before `git clean -fd`, scan for `.gitmodules` and `submodule.*` entries in `git config --file .git/config`. If any exist, downgrade to `git clean -fdx --exclude="<submodule-paths>"` or refuse the hard restart and park the agent.

## Medium (UX gaps, missing safety nets)

- **[C2] `acquireInstanceLock` calls `process.exit(1)` from a library helper**
  - `scripts/lib/locking.js:29, 52` exits the process directly when it detects a competing loop. That makes the helper untestable in-process and leaves no room for callers to do their own cleanup (release temp files, flush logs, etc.).
  - *Fix:* Throw a structured error (`code: "ELOCKED"`, attach the detected PID/cmd) and let `orchestrator-loop.js` format the message and exit. Update `tests/locking.test.js` to assert against the thrown error.

- **[C2] `pidMatchesCli` substring match is permissive**
  - `scripts/lib/process.js:54` does `cmdline.toLowerCase().includes(expectedCli.toLowerCase())`. An unrelated process whose cmdline happens to contain the CLI name (e.g., `vim cli-templates/codex.md`, `tail codex.log`) matches. Combined with PID recycling this can lead the loop into signalling the wrong process before the events-log fallback even engages.
  - *Fix:* Compare the basename of the first argv token against `expectedCli` (path-aware), and only fall back to substring when the recorded `spawned_cmdline` also matches. Add tests for the false-positive cases.

- **[C2] `processApprovals` order also drops the `agent_completed` / decision audit if the `safeKill` happens to crash the loop**
  - In `processActions`, the sequence for a passing validation is `finalizeEndAgentCompletion` → `safeKill` → `appendEvent("agent_completed")`. If `safeKill` raises (e.g., `process.kill` permission error path that escapes the try/catch via a future refactor), the `agent_completed` event is never written even though the agent is marked `completed`.
  - *Fix:* Emit `agent_completed` immediately after the COMPLETED transition (already inside the lock), then signal the worker. The event is cheap and idempotent at the consumer.

- **[C2] `abort.flag` has no identity, so a stale flag from a prior run can short-circuit a fresh launch**
  - `scripts/orchestrator-loop.js:81` only checks for `existsSync(abort.flag)` and unlinks it after handling. If a prior run was killed before unlinking (or the user wrote it manually for testing), the next loop boots, sees the flag, aborts immediately, and unlinks it — wasting one full launch cycle.
  - *Fix:* Write the abort flag as JSON `{ pid, written_at }`. On startup, ignore flags whose `written_at` predates the current `current_run.json` started_at. Dashboard's Ctrl+C writer should include those fields.

- **[C2] `default_base_branch` discovery falls back to literal `"main"`**
  - `scripts/launch-all.js:530-540` returns `"main"` if `git rev-parse --abbrev-ref HEAD` fails or is empty. `scripts/orchestrator-loop.js:1771` then probes `["main", "master"]` for the ownership base. Repos using `trunk`, `develop`, or other defaults silently use a wrong base for ownership and `git diff` snapshots.
  - *Fix:* Read `git symbolic-ref refs/remotes/origin/HEAD` (or `git config --get init.defaultBranch`) and fall back to the current branch only if both fail. Surface the resolved base in the `Model heads-up` block at launch.

- **[C2] `isRuntimeCoordSymlink` only excuses the top-level `coord` entry from ownership checks**
  - `scripts/orchestrator-loop.js:1872-1879` filters the path `"coord"` itself when it is a symlink. But the ownership-check walker (`addGitLines`) emits entries below it (`coord/requests/<file>.json`, `coord/progress/<agent>.json`) when a worker writes through the symlink. Those slip past the filter and trip "outside allowed_paths" on completion.
  - *Fix:* If the top-level `coord` is a symlink, also drop every changed file whose first path segment is `coord`. Add a regression that writes through the symlink and asserts ownership passes.

- **[C2] Tmp prompt files leak under `os.tmpdir()`**
  - `scripts/launch-all.js:167-169` writes `launch-all-prompt-<agent>-<ts>.txt` to `os.tmpdir()` and never deletes it. `scripts/orchestrator-loop.js` deletes the `orch-prompt-<pid>-<ts>.txt` files but not the per-restart `coord/prompts/restart-*.txt` (kept on purpose for forensics but unbounded).
  - *Fix:* Delete each `launch-all-prompt-*.txt` after `spawn-agent.js` returns successfully. Add a small sweeper for `coord/prompts/` that keeps the N most-recent files per agent (mirroring the `loop-runs/` retention).

- **[C2] `processActions` silently ignores unknown agents in arbitration output**
  - `scripts/orchestrator-loop.js:367-458`: an `end_agent` for an agent not in `agents.json` falls through `if (!snapshot)`; a `soft_restart`/`hard_restart` for an unknown agent makes `bumpRestartAndRespawn` no-op inside its `updateJSON` callback. Either way the loop emits no warning and the orchestrator CLI gets no feedback that its response was malformed.
  - *Fix:* Log a clear `Arbitration action targeted unknown agent <name>` warning and emit an `arbitration_action_dropped` structured event (new `events.js` type) so it shows up in `inspect-live-test.js`.

- **[C2] `writeAtomic` skips fsync; rename-without-flush can lose committed state on power loss**
  - `scripts/lib/locking.js:291-295` writes to a tmp file then renames. On crash/poweroff between rename and the page cache flushing, the new content can be lost while the rename is observed. Most of the time this is fine, but `agents.json`, `current_run.json`, and `decisions.jsonl` represent committed state.
  - *Fix:* Open the tmp file with `'w'`, write, then `fsyncSync(fd)` before `closeSync` and `renameSync`. Optional on append-only files where the loss is recoverable. Tests that don't care about fsync can stay green; add one that asserts the fsync was invoked via a stub.

- **[C1] `gpt-5.4-mini` recommendation is not a real model id**
  - `scripts/lib/model-recommendations.js:13` lists `model: "gpt-5.4-mini"`. There is no published GPT‑5.4 line — the closest valid ids are `gpt-5-mini` (or the current `gpt-4o-mini` family for Codex-compatible deployments). Operators copying this into their config get a 404 from the provider.
  - *Fix:* Update to the current real id, or change the field to `model: "<provider-cost-tier-id>"` + a `notes` field that explains which family to pick.

- **[C1] `callOrchestratorCli` retry loop doesn't re-check `abort.flag` between attempts**
  - `scripts/orchestrator-loop.js:2042-2061` awaits a CLI subprocess (which watches the abort flag), but on a retry boundary the loop just calls `invokeOrchestratorCli` again without re-checking the flag.
  - *Fix:* After each `invokeOrchestratorCli` await, return early if `fs.existsSync(abortFlagPath)`. The next loop iteration will run the real abort path.

- **[C1] `renderRestartPrompt` re-reads `worker-prompt-template.md` on every restart**
  - `scripts/lib/restart-prompt.js:38-40` calls `fs.readFileSync` against the template inside `renderRestartContractPrompt`. A long-running loop with frequent restarts hammers the filesystem unnecessarily.
  - *Fix:* Cache the template content per process (memoize on first call). Invalidate on `mtime` change for dev workflows if needed.

- **[C1] `dashboard.js` argument parser is positional and brittle**
  - `scripts/dashboard.js:15` uses `process.argv[2] === "--coord" ? process.argv[3] : "./coord"`. Any other leading flag (e.g., a future `--no-color`) makes `--coord` invisible.
  - *Fix:* Replace with a tiny flag loop matching the other scripts (`for (let i = 2; i < argv.length; i++) …`). Accept `--interval` while you're there.

- **[C1] `appendLog` double-prints to stdout under `nohup`**
  - `scripts/orchestrator-loop.js:1391-1396` calls `fs.appendFileSync` AND `console.log`. Under `launch-all.js` the loop is started via `nohup … >> loop.out 2>&1 &`, so stdout is already redirected to a file. Every log line gets written twice — once by the appender and once by `nohup`'s redirect.
  - *Fix:* Drop the `console.log` when running as the loop (detect via `process.stdout.isTTY === false`), or pipe through a single sink. The interactive `--poll-interval` developer experience can stay TTY-aware.

- **[C1] `claude_failure_threshold` deprecation warning fires on every `loadConfig` call**
  - `scripts/lib/config.js:165` logs to stderr each time. `loadConfig()` is called by `preflight.js`, `launch-all.js`, `spawn-agent.js` (once per spawn/respawn), `orchestrator-loop.js`, `resume-agent.js`, etc. — operators see the same warning a dozen times per run.
  - *Fix:* Cache "warned for this process" in a module-level flag, or attach a `__warned` symbol to the returned config.

- **[C1] `tailLines` may drop a complete first line under the byte cap**
  - `scripts/lib/log-tail.js:52`: the head-fragment guard always discards the first split element when `start > 0 && split.length > 1`, even if the byte at `start` happens to be `\n` (i.e., the window starts cleanly on a line boundary). Worst case: the dashboard's "last line" actually drops one valid line on logs whose tail aligns with a 64 KB boundary.
  - *Fix:* Only drop the head fragment when the byte before `start` is not `\n`.

- **[C1] Dashboard refresh interval is hard-coded to 2 s**
  - `scripts/dashboard.js:53` runs `setInterval(render, 2000)`. No flag, no config key.
  - *Fix:* Add `--interval <ms>` to the dashboard CLI (default 2000). Also accept `--no-clear` to keep scrollback (useful for sshfs / tmux setups).

- **[C1] Stalled-flag context is lost once the CLI recovers**
  - `scripts/orchestrator-loop.js:2162-2189` writes `orchestrator-stalled.flag` with the high-priority-blocked counts, then `clearStalledFlag` unlinks it on recovery. Operators who weren't watching have no record of the incident.
  - *Fix:* Before unlinking, append the flag JSON to `events.jsonl` as a new `orchestrator_cli_stalled_cleared` event so the dashboard / `inspect-live-test.js` can render the history.

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

## Low (cleanup, doc drift)

- **[C1] Document the `--` passthrough on `spawn-agent.js`**
  - `scripts/spawn-agent.js:223-231` appends post-`--` args to the CLI template, with an explicit warning that args are not sanitized. Mentioned nowhere in `references/schemas.md` or `SKILL.md`.
  - *Fix:* Either document under "Power-user spawn options" or remove if no caller needs it.

- **[C1] `inspect-live-test.js` reads `orchestrator.instance.lock/pid` directly**
  - `scripts/inspect-live-test.js:115` hardcodes the lock-dir layout (`orchestrator.instance.lock/pid`). When `lib/locking.js` evolves the lock format (e.g., the staged-rename fix above), this reads the wrong file.
  - *Fix:* Export a `readLoopPid(coordDir)` helper from `lib/locking.js` and use it here.

- **[C1] Built-in defaults across `lib/config.js` duplicate values exported elsewhere**
  - `DEFAULT_WORKER_LOG_MAX_BYTES` is repeated in `lib/log-tail.js` as `DEFAULT_MAX_LOG_BYTES`. The comment says "Keep them in sync"; that's a smell.
  - *Fix:* Import the constant from `lib/log-tail.js` instead of duplicating.

## Test gaps

- **[C2] Crash mid-`processApprovals`**: write a test that injects a fault between `appendDecisionRecords` and `updateJSONL`, then reboots the loop and confirms no request is re-arbitrated.
- **[C2] Concurrent lock acquire**: spawn N parallel `acquireLock` callers against the same file and assert no caller sees a half-formed lock (no missing pid file, no premature stale-cleanup).
- **[C2] `pidMatchesCli` false-positive**: confirm that an unrelated process whose cmdline contains the CLI name (`vim codex.md`) does NOT match.
- **[C2] Per-cycle subprocess count**: assert that with 10 running agents, one main-loop tick spawns at most one `ps` and at most one `git` per agent (regression for the perf fix above).
- **[C2] Coord symlink subtree ownership**: simulate a worker writing `coord/requests/foo.json` via the symlink and assert ownership check passes.
- **[C2] Submodule survives `captureRecoveryAndReset`**: stage a `.gitmodules` entry in a worker worktree, trigger a hard restart, and assert the submodule path is preserved (or the hard restart refuses).
- **[C1] Tail-window line-boundary**: a 64 KB-aligned log file does not lose its leading complete line.
- **[C1] Stale `abort.flag`**: a flag whose JSON `written_at` predates `current_run.json.started_at` is ignored on boot.
- **[C1] `dashboard.js` flag parsing**: `--no-color --coord ./other` resolves the coord directory correctly.
