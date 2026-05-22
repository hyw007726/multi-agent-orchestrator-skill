# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)

- [x] **[C3] Prevent double-spawn on active runs**: add an active-run guard before `launch-all.js` creates or resumes any worker worktree/process, including the `--resume` path. The guard should detect an existing live orchestrator loop for the same `coord/` and fail before touching `agents.json`, worker logs, or worktrees. Add a regression test for `launch-all --resume` while a run is active.

- [x] **[C2] Remove shell-based orchestrator loop launch**: replace the `shell: true` `nohup ... >> ... &` launch in `launch-all.js` with argv-based `spawn(process.execPath, [orchestratorLoopPath, "--coord", coordDir], ...)` and direct log-file stdio. Add a test proving shell metacharacters in `--coord` are treated as literal path text.

- [x] **[C3] Split worker access to coordination state**: stop exposing the whole `coord/` tree as a writable symlink inside worker worktrees. Provide read-only access to `DECISIONS.md`, `CALLER_CONTEXT.md`, `context.json`, and recent decisions, plus validated write-only ingress for `requests/` and `progress/`. Update prompts, spawn setup, staged-request handling, and ownership checks accordingly.

- [x] **[C3] Make arbitration request/action handling transactional**: validate arbitrator output before side effects, require every pending request to be approved or rejected, and persist action intent/request resolution before killing, committing, or respawning workers. Add tests for restart/end-agent responses that omit approvals and for crashes between action scheduling and request resolution.

- [x] **[C2] Investigate lock visibility race**: the full `node scripts/run-tests.js` run observed one half-formed lock state in `tests/locking.test.js`, while isolated rerun passed. Reproduce under stress, fix `acquireLock`/test TOCTOU as needed, and keep a regression that proves lock directories are never observable without a valid `pid`.

## Medium (UX gaps, missing safety nets)

- [x] **[C2] Make manual resume failure-safe**: if `resume-agent.js` flips a parked agent to `running` but `spawn-agent.js` fails, restore or re-park the agent with clear `attention_reason` / `next_steps` instead of leaving a stale running record. Add a regression for resume relaunch failure.

- [x] **[C2] Make staged request ingestion idempotent**: prevent duplicate request ingestion if the loop crashes after appending staged requests to `requests.jsonl` but before deleting staged `.json` files. Deduplicate by `request_id` or move staged files through a processing/consumed state before append. Add a crash-replay regression.

- [x] **[C2] Bound all dynamic arbitration prompt sections**: `buildBoundedArbitrationPrompt` currently truncates request content and worktree state only. Add size caps for `context.json`, `DECISIONS.md`, `CALLER_CONTEXT.md`, and recent decisions, and log which sections were truncated so small-context arbitrator CLIs stay reliable.

- [x] **[C1] Add regression coverage for review-discovered edge cases**: cover active-run resume launch, shell-metacharacter coord paths, missing approval entries in arbitrator responses, staged request replay, resume spawn failure, and oversized non-request arbitration context.
