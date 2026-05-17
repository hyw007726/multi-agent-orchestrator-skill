# TODO

Each item is tagged with a complexity rating:

- **[C1]** - small surgical change, single file, clear logic, low risk.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

# Async Manual Intervention

Today `STATUS.ERRORED` is overloaded: budget-exhausted (`orchestrator-loop.js:450`), liveness timeout (`:159`), and hard-reset-failed (`:495`) all preserve the worktree but read as "given up". A distinct `needs_attention` state lets the dashboard, the all-finished gate (`:265`), and `failedCount` (`:1850`) tell *parked-pending-review* apart from *truly errored*.

Batches are sequenced so each one lands the repo in a working state. Run a yolo session per batch in order; don't start a later batch until the prior one is merged.

## Batch 1 — Foundation (policy + inert status plumbing)

Lands the substrate without changing runtime behavior. Nothing transitions to `needs_attention` yet — that flip happens in Batch 2.

- **[C2]** Decide the routing policy for which failures park the agent vs. which keep recovering. Split into two classes: *still in budget* (repeated validation failures — already converted to `soft_restart` at `orchestrator-loop.js:396` — and progress timeouts with restart budget remaining) keep recovering; *no cheap recovery possible* (file-ownership violations, unresolved conflicts, broken CLI/auth/model setup, ambiguous product decisions, and budget-exhausted variants of the recoverable class) park immediately. Write the policy table down (e.g. `docs/manual-intervention-policy.md`) — Batch 2 references it directly.

- **[C3]** Add `STATUS.NEEDS_ATTENTION` in `scripts/lib/status.js:9` and audit every status comparison: the all-finished gate (`orchestrator-loop.js:265`), `failedCount` (`:1850`), and the terminal-set in `findExitedAgentName` (`:1902`). Treat `needs_attention` as terminal for the loop-can-exit check but not for the task-succeeded check. Extend `transitionAgentStatus` (or add a wrapper) so callers can set `attention_reason`, `attention_at`, and `next_steps` atomically with the status flip.

**Done when:** policy doc exists; tests pass; grepping for `"errored"` / `"completed"` in status comparisons turns up no site that should also handle `needs_attention`; no caller transitions to the new status yet.

## Batch 2 — Re-route the three sites

First batch where runtime behavior changes. Dashboard will show the raw `needs_attention` string with default rendering — that's fine, Batch 3 cleans it up.

- **[C2]** Re-route the three currently-ERRORED-but-worktree-preserved sites to `needs_attention` per the Batch 1 policy table: budget-exhausted (`orchestrator-loop.js:450`), liveness timeout (`:159`), and hard-reset-failed (`:495`). Reuse the existing `buildProgressEscalation` rationale (`:851`) to populate `next_steps` rather than hand-writing strings at each call site. Append a structured event for every transition. Explicit non-goal: there is no auto-resolution or stale-timeout — a parked agent sits until a human intervenes.

**Done when:** triggering each of the three conditions in a live or unit test leaves the agent at `needs_attention` with `attention_reason` / `attention_at` / `next_steps` populated and worktree intact; an event is appended; `STATUS.ERRORED` is reserved for the truly-give-up paths.

## Batch 3 — Dashboard surfacing

- **[C2]** Surface `needs_attention` in `dashboard.js` by extending the status branch at `:91` with a distinct color and the `attention_reason` summary. Do **not** add `coord/manual-intervention.flag` unless an external consumer is named — `agents.json` already carries the same signal and a duplicate file-based flag risks drifting from it.

**Done when:** dashboard run against a fixture with a parked agent renders it visually distinct from `errored` and shows the reason on one line.

## Batch 4 — Resume primitive + docs

Pair these — writing the doc without having driven the resume end-to-end produces docs that don't match reality. C1 docs item is folded in.

- **[C2]** Add an explicit resume primitive so a human can relaunch a parked worker after fixing the worktree. Decide the surface (orchestrator CLI flag vs. coordination-file instruction vs. re-queued task) and the state transitions (`needs_attention` → `running`, clear `attention_*` fields, reset or preserve `restart_count`).

- **[C1]** Document the resolution workflow: inspect `coord/logs/<agent>.log`, inspect or fix the worker worktree, update coordination context if needed, then invoke the resume primitive.

**Done when:** a parked agent can be resumed via the new primitive in a manual end-to-end test, `attention_*` fields clear on the transition, and the doc walks through the same flow the author just performed.
