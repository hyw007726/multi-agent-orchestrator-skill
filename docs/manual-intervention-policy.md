# Manual Intervention Routing Policy

This document defines **which agent failures keep recovering automatically** and
**which park the agent for a human** in the new `needs_attention` status.

It is the source of truth for Batch 2 of the *Async Manual Intervention* work in
`TODO.md`. Batch 1 only lands the substrate (the status constant, the audit, and
the `parkAgentForAttention` helper) — no site routes here yet. Line numbers below
reference the code as of Batch 1.

## Principle

`STATUS.ERRORED` historically meant two unrelated things: "the orchestrator gave
up and threw the work away" and "the orchestrator stopped but the worktree is
intact and a human could pick it up". The second case is *parked-pending-review*,
not *errored*. The split is:

- **Cheap recovery still available** → keep the existing automatic recovery
  (soft/hard restart). Do **not** park.
- **No cheap recovery** → stop touching it, preserve the worktree, set
  `needs_attention` with `attention_reason` / `attention_at` / `next_steps`, and
  wait for a human. There is no auto-resolution and no stale timeout — a parked
  agent sits until a human intervenes.

A budget-exhausted variant of any otherwise-recoverable failure falls into the
**park** class: the cheap recovery has been spent.

## Class A — Still in budget / cheap recovery (keep recovering, do NOT park)

| Failure mode | Current call site | Current handling | Why it stays recoverable |
|---|---|---|---|
| Repeated validation failure | `scripts/orchestrator-loop.js:396` | Converted to `soft_restart` via `bumpRestartAndRespawn` | A restart with the validation log fed back fixes most of these; cost is one more worker run within the restart budget. |
| Progress timeout, first occurrence | `buildProgressEscalation` → `first_timeout`, `scripts/orchestrator-loop.js:867` | `suggestedAction: "soft_restart"` | Agent is alive but made no git-visible progress; a deterministic nudge usually unblocks it. |
| Progress timeout, second occurrence | `buildProgressEscalation` → `repeated_timeout`, `scripts/orchestrator-loop.js:877` | `suggestedAction: "soft_restart"` (stronger instruction) | Still within restart budget; one more stronger soft restart is cheaper than a human round-trip. |

These keep flowing through `bumpRestartAndRespawn`. They only leave Class A when
the restart budget runs out (see Class B).

## Class B — No cheap recovery (park immediately into `needs_attention`)

| Failure mode | Current call site | Current handling (Batch 1) | Why no cheap recovery |
|---|---|---|---|
| Restart budget exhausted (covers budget-exhausted validation failures and budget-exhausted progress timeouts) | `scripts/orchestrator-loop.js:450` | `STATUS.ERRORED`, worktree preserved, not respawned | The cheap path (restart) has already been spent `default_max_restarts` times; another restart is not "cheap", it is a loop. |
| Liveness timeout (no log output for `timeout_mins`) | `scripts/orchestrator-loop.js:159` | `STATUS.ERRORED`, worktree preserved | The worker is wedged or its CLI/auth/model setup is broken; restarting blindly tends to re-wedge. Needs a human to inspect the log/worktree. |
| Hard-restart recovery/reset failed | `scripts/orchestrator-loop.js:496` | `STATUS.ERRORED`, worktree preserved | The recovery primitive itself failed; there is no further automatic fallback. |
| Progress timeout with no restart budget remaining | `buildProgressEscalation` → `restart_budget_exhausted`, `scripts/orchestrator-loop.js:857` | `suggestedAction: "manual_inspection"` | Explicitly signals there is no budget left to spend. |
| File-ownership violation | `scripts/orchestrator-loop.js:340` | Currently `soft_restart` with `skipWipCommit` (`:353`) | The worker changed files outside its assigned ownership — an out-of-scope/ambiguous-scope decision a human must adjudicate, not something a re-prompt reliably fixes. Target state: park. |
| Unresolved conflict | conflict request type, `scripts/orchestrator-loop.js:20` | Arbitration / human review | Cross-worker conflicts need a human or the arbitration owner to decide; no cheap deterministic fix. |
| Broken CLI / auth / model setup | surfaces as liveness timeout (`:159`) or CLI-failure threshold | Stalled flag / `ERRORED` | Environmental; no amount of restarting fixes missing auth or a misconfigured CLI. |
| Ambiguous product decision | surfaces as a `question` / `change` request | Arbitration / human review | Requires a product call the orchestrator is not authorized to make. |

### Batch 2 scope note

Batch 2 re-routes exactly the three currently-`ERRORED`-but-worktree-preserved
sites to `needs_attention`:

1. Restart budget exhausted — `scripts/orchestrator-loop.js:450`
2. Liveness timeout — `scripts/orchestrator-loop.js:159`
3. Hard-restart recovery failed — `scripts/orchestrator-loop.js:496`

`next_steps` for these is populated from the existing
`buildProgressEscalation` rationale (`scripts/orchestrator-loop.js:852`) rather
than hand-written per call site.

The remaining Class B rows (file-ownership violations, conflicts, environmental
breakage, ambiguous product decisions) are the documented *target* policy. Their
re-route is tracked beyond Batch 2's three core sites and is out of scope for the
initial flip; they are recorded here so the routing intent is unambiguous.

`STATUS.ERRORED` is reserved, after Batch 2, for the truly-give-up paths only.
