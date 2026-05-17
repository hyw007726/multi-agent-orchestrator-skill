# TODO

Each item is tagged with a complexity rating:

- **[C1]** - small surgical change, single file, clear logic, low risk.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

# Async Manual Intervention

- **[C3]** Add an asynchronous manual-attention workflow for workers that reach an automation confidence boundary. Prefer a status such as `needs_attention` over `paused` so it is clear the worker process is stopped and the preserved worktree needs review.

- **[C2]** When restart budget is exhausted, transition the agent to `needs_attention` instead of `errored`, preserve the worktree, record `attention_reason`, `attention_at`, and actionable `next_steps` in `agents.json`, and append a structured event.

- **[C2]** Surface `needs_attention` prominently in `dashboard.js` with a distinct color and concise reason, and optionally write `coord/manual-intervention.flag` when any agent needs human/caller review.

- **[C2]** Document the resolution workflow: inspect `coord/logs/<agent>.log`, inspect or fix the worker worktree, update coordination context if needed, then resume or relaunch the worker intentionally.

- **[C2]** Decide which failures should become manual-attention checkpoints, including repeated validation failures, file-ownership violations, unresolved conflicts, broken CLI/auth/model setup, repeated progress timeouts after recovery, or ambiguous product decisions.

# Design Review Follow-Ups

- **[C3]** Revisit default CLI prompt transport. Prefer prompt-file or stdin-backed templates where CLIs support them to avoid leaking full prompts in process listings and to reduce argument-length failures.

- [x] **[C1]** Make liveness PID checks use the same CLI-aware PID matching as `safeKill()` so recycled PIDs are not treated as still-running worker processes.

# Logging Consistency

- **[C2]** Unify worker log verbosity across providers so claude/gemini emit the same kind of reasoning + tool-call trace that `codex exec` already streams by default. Update `DEFAULT_CLI_TEMPLATES` in `scripts/lib/config.js`: add `--output-format stream-json --include-partial-messages --verbose` to the claude template, and `--output-format stream-json` to the gemini template. Codex stays as-is. Note: switches all three log streams to JSONL, so any dashboard/log-reader code that currently treats logs as opaque text will need a per-provider event parser. No API token cost — output-format flags only change CLI stdout, not what the model generates. Consider adding log rotation for `coord/logs/<agent>.log` at the same time since traces will grow log size substantially.
