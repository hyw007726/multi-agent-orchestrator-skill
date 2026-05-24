# Resolving a `needs_attention` Agent

When the orchestrator parks a worker into `STATUS.NEEDS_ATTENTION`, it has
stopped touching that agent on purpose: the worktree is intact, no automatic
recovery is left to try, and the agent will sit untouched until a human steps
in. There is **no auto-resolution and no stale timeout** — parking is
permanent until you run the resume primitive.

This document is the operator runbook for that flow. It pairs with
[`manual-intervention-policy.md`](manual-intervention-policy.md), which decides
*which* failures park; this one covers *what you do once one is parked*. Every
command below is copy-pasteable from the project root (the directory that holds
`coord/`); substitute the real agent name for `<agent>` and adjust `--coord`
if your coordination directory is not `./coord`.

## 1. Detect a parked agent

The dashboard renders a parked agent as an amber `ATTENTION: <reason>` row,
distinct from a vanished `exited` row:

```
node scripts/dashboard.js --coord ./coord
```

Or query `agents.json` directly:

```
jq '[to_entries[] | select(.value.status=="needs_attention") | {agent: .key, reason: .value.attention_reason, at: .value.attention_at}]' coord/agents.json
```

The deterministic end-of-run summary also flags this: a run with a parked
agent and no failures is titled `AWAITING REVIEW` (see
`coord/review-summary.txt`).

## 2. Inspect

Pull the three pieces of context the park site left for you.

**The agent's own fields** — `attention_reason` is the trigger;
`next_steps` is the canonical recovery guidance for that park site (owned by
`parkRationale` in `scripts/lib/status.js`):

```
jq -r '.["<agent>"] | "reason: \(.attention_reason)\nparked_at: \(.attention_at)\nnext_steps: \(.next_steps)"' coord/agents.json
```

**The worker log** — the last lines usually show how it wedged or what
error it hit:

```
tail -n 50 coord/logs/<agent>.log
```

**The worktree** — the work-in-progress is preserved exactly as the worker
left it. Find the path and inspect git state:

```
WT=$(jq -r '.["<agent>"].worktree' coord/agents.json)
git -C "$WT" status
git -C "$WT" diff
```

Three park sites currently route here (the three Class B
"no cheap recovery" sites in the policy doc). Their typical fixes:

| `attention_reason` matches | What happened | Typical fix |
|---|---|---|
| `liveness timeout - idle N mins` | No log output within the liveness window — usually a wedged worker or a broken CLI/auth/model setup. | Inspect the log tail for an auth/model error; re-authenticate the CLI or correct the model id in `orchestrator.config.*`; if the worker is merely wedged, no environment change is needed. |
| `max restarts (N) exhausted` | The soft/hard restart budget was fully spent on the same failure. | Read the log to find what kept failing across restarts (a flaky test, an unmet dependency, an impossible instruction); fix that root cause in the worktree or sharpen the instruction before resuming. |
| `hard restart recovery failed: <err>` | The hard-restart reset primitive itself failed, leaving the worktree in an unknown state. | Repair the worktree by hand — resolve the rebase/checkout that blocked the reset, commit or stash salvageable work, get `git -C "$WT" status` clean enough to continue. |

## 3. Fix the underlying cause

Resolve the real problem before resuming — resume relaunches the worker as-is,
so an unfixed cause just re-parks it (now with a fresh restart budget to burn).
Concrete examples, one per park site:

- **Broken CLI / auth (liveness timeout).** The log tail shows
  `authentication failed`. Re-run the CLI's login (e.g. `claude /login` or the
  vendor's auth command) so the worker process can actually start producing
  output.
- **Spent restart budget.** The log shows the validation command failing every
  attempt because a dependency is missing. Install it in the worktree (or fix
  `validate_cmd` in `coord/context.json`) so the next run can pass.
- **Hard-restart recovery failed.** `git -C "$WT" status` shows an
  interrupted rebase. Run `git -C "$WT" rebase --abort` (or finish it), commit
  what is worth keeping, and confirm the tree is clean.

## 4. Update the coordination context (only if the fix changes the plan)

If the root cause changes *what the worker should do* — not just its
environment — update the shared context so the relaunched worker (and the
orchestrator) sees the new reality:

- `coord/context.json` — task description, `allowed_paths`/`forbidden_paths`,
  or `validate_cmd` for this agent.
- `coord/CALLER_CONTEXT.md` — session-level guidance; it is folded into the
  resume prompt automatically.
- `coord/DECISIONS.md` — record a scope/product decision you made so it
  survives future restarts.

This step is **overkill** for a pure environment fix (re-auth, install a
dependency, repair a wedged worktree): the original task still stands, so skip
it and go straight to resume. It **matters** when you are also redirecting the
work — in that case prefer passing the new direction via `--instruction`
(step 5) so it lands in the worker's restart prompt verbatim.

## 5. Resume

The resume primitive is `scripts/resume-agent.js`. It atomically flips
`needs_attention` → `running`, clears `attention_reason` / `attention_at` /
`next_steps`, resets the liveness clock, and relaunches the worker via
`scripts/spawn-agent.js`. It works whether or not the orchestrator loop is
running; if the loop is up it re-adopts the relaunched worker the same way it
handles any restart.

Default resume (resets `restart_count` to 0 — a fresh budget, on the
assumption you fixed the cause; reuses the agent's existing task as the
instruction):

```
node scripts/resume-agent.js --agent <agent> --coord ./coord
```

Give the worker a new instruction (overrides the stored task; use this when
you redirected the work in step 4):

```
node scripts/resume-agent.js --agent <agent> --coord ./coord --instruction "Skip the flaky e2e suite; finish the API handler only."
```

Long instructions can come from a file instead:

```
node scripts/resume-agent.js --agent <agent> --coord ./coord --instruction-file ./new-direction.md
```

Audit-style resume that keeps the spent budget (rare — use only when you
deliberately want the next failure to re-park immediately rather than burn a
fresh restart budget):

```
node scripts/resume-agent.js --agent <agent> --coord ./coord --preserve-restart-count
```

The script refuses (exits non-zero, record untouched) if the agent is not in
`needs_attention` — resuming a `running`, `completed`, or `exited`
agent is almost certainly a mistake, so it is rejected rather than guessed at.

## 6. Verify

A successful resume is observable:

- **Status flips.** The dashboard row goes from amber `ATTENTION:` back to a
  normal running row; `jq -r '.["<agent>"].status' coord/agents.json` prints
  `running` and the `attention_*` / `next_steps` fields are gone.
- **Fresh heartbeat.** `last_heartbeat` / `current_started_at` are now
  (`jq -r '.["<agent>"] | .last_heartbeat, .current_started_at' coord/agents.json`).
- **Log picks up.** `coord/logs/<agent>.log` is appended to, not truncated —
  the new worker output continues below the pre-park lines.
- **Event trail.** The event log shows the full lifecycle (`events.jsonl`
  is JSONL — one JSON object per line, so filter per line with `jq -c`):

  ```
  jq -c 'select(.agent=="<agent>" and (.event=="agent_parked" or .event=="agent_resumed"))' coord/events.jsonl
  ```

  You should see `agent_parked` followed by `agent_resumed`, the latter
  carrying `reset_restart_count` and the `prior_attention_reason` /
  `prior_attention_at` it cleared.

## Non-goals

- **No auto-resume.** A parked agent never un-parks itself; only
  `resume-agent.js` (a deliberate human action) moves it.
- **No stale timeout.** Parking does not expire. An agent parked for a minute
  and one parked for a week are treated identically.
- **No automatic forgiveness of restart counts.** The budget reset is opt-out,
  not implicit: default resume resets it, `--preserve-restart-count` keeps it,
  and nothing else ever zeroes or decays `restart_count` on its own.
