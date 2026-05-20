# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)


## Medium (UX gaps, missing safety nets)

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
