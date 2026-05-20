---
name: multi-agent-orchestrator
description: Decompose a large coding task into parallel worker agents (Claude, Codex, Gemini, Kilo, OpenCode, or custom CLIs) running in isolated git worktrees with self-healing supervision. Use when the user asks to "build something complex with multiple agents", "split this work in parallel", "spawn a swarm", or to coordinate background headless CLI workers.
---

# Multi-Agent Orchestrator Skill

This skill defines a caller-neutral, CLI-agnostic multi-agent orchestration system.

## Canonical commands

Each phase has exactly one recommended command. Alternative entry points are documented in the [Power-user appendix](#power-user-appendix).

| Phase | Canonical command |
|-------|-------------------|
| Phase 0 — Preflight | `scripts/preflight.js` |
| Phases 1–2 — Decompose, bootstrap, materialize | `scripts/prepare-run.js` |
| Phase 1.5 — Plan review (optional) | `scripts/review-plan.js` |
| Phase 4 — Launch | `scripts/launch-all.js` |
| Monitoring | `scripts/status.js` |

`status.js` is the single "what's happening right now" probe. It reads
`coord/agents.json`, `coord/events.jsonl`, and `coord/orchestrator-stalled.flag`
and emits a structured snapshot. The four scripts the orchestrator session
consumes (`preflight.js`, `validate-context.js`, `launch-all.js`, `status.js`)
all accept `--json` for stable machine-readable output — see
`references/schemas.md`.

## Prerequisites

- **A headless worker CLI is installed and fully configured.** The skill ships
  with `default_cli: kilo` and can also drive Claude Code, Codex, Gemini,
  Kilo Code, OpenCode, or any custom CLI added to `cli_templates`. Each CLI
  must already be signed in, have a model selected, and run non-interactively —
  workers run with permission-bypass flags (`--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--auto`), so any
  unhandled interactive prompt will hang or crash a worker.
- **No npm install.** All scripts use Node.js built-ins.

## Caveats

- The caller session owns shared foundation work before launch and final diff
  review, validation, merge, and worktree cleanup after workers finish. The
  runtime supervises workers but does not replace integration review.
- Git worktrees reduce accidental overlap, not all overlap. Workers can still
  touch shared files or make incompatible choices that need manual reconciliation.

## Caller support

Use this workflow from any local coding-agent caller that can read `SKILL.md`
and run shell commands:

- **Claude Code**: install this folder as a Claude Code skill.
- **Codex**: install this folder as a Codex skill (`agents/openai.yaml` for UI metadata, `AGENTS.md` for a repo-level caller guide).
- **Gemini CLI**: install this folder as a Gemini extension (`gemini-extension.json` loads `GEMINI.md` which imports this `SKILL.md`).
- **Other local callers**: instruct the caller to read this `SKILL.md` and use the absolute path to this repository when running scripts.

The runtime is independent of the caller. The caller only performs
decomposition, file edits, script launches, and final integration.

## Intelligence boundaries

This skill keeps architectural judgment in the interactive caller session and
uses configurable CLIs only where headless execution is necessary. It relies on
**three distinct contexts**:

1. **Initial decomposition (interactive)** — your caller session analyzes the
   task, chooses the topology, writes the draft plan, materializes
   `coord/context.json`, and launches workers only after approval.
2. **Background loop (headless)** — once launched, the loop has no access to
   your chat history. It invokes `orchestrator_cli` (falls back to
   `default_cli`) only for request arbitration: pending worker questions,
   synthetic `progress_timeout` requests, and `end_agent` / `soft_restart` /
   `hard_restart` actions.
3. **Final integration (interactive)** — after the loop completes it writes a
   deterministic `coord/review-summary.txt`. Return to the caller session to
   review diffs and merge.

**Model selection.** Use a powerful reasoning model for the caller sessions
(contexts 1 and 3). Configure the worker CLI (`default_cli`) for cost-efficient
bulk coding. Set `orchestrator_cli` only when arbitration should use a
different CLI/model from the workers.

**Pinning a model.** Selection stays attached to the CLI that launches the
worker. If the CLI takes a launch-time model flag, pin it in `cli_templates` —
for example `{ cmd: "claude", args: ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--model", "claude-sonnet-4-6"], stdin: { prompt_file: true } }`, or add `--model gpt-5.4-mini` to a Codex template. CLIs without a launch-time
model flag must select the model in their own settings. Unpinned templates use
the CLI's current default.

`claude` is the one CLI where pinning is effectively required: when launched
from Claude Code without `--model`, the spawned worker inherits the parent
session's (often expensive) model. The shipped `cli_templates.claude` already
pins Sonnet 4.6.

There is intentionally no `default_model` config key — each CLI uses different
flag names and model-id namespaces, so keeping selection next to the launch
mechanism avoids a leaky aliasing layer.

**Provider-family recommendations.** Preflight prints advisory second-tier
worker recommendations on model/auth failures. These are user actions, not
automatic fallbacks: current picks are Claude `claude-sonnet-4-6`, Codex/OpenAI
`gpt-5.4-mini`, and Gemini `gemini-2.5-flash-lite`. Persist accepted choices in
`orchestrator.config.local.jsonc` (personal) or `orchestrator.config.jsonc`
(shared), then rerun preflight.

**Per-worker model differences.** Do not add `tasks.<name>.model`. Define
separate CLI aliases instead (e.g. `claude-sonnet-worker`, `claude-fast-worker`),
each with its own `cli_templates.<alias>` and `cli_health_checks.<alias>`, and
set `tasks.<name>.cli` to the alias.

## Configuration (`orchestrator.config.jsonc`)

Before Phase 1, check whether `orchestrator.config.jsonc` exists in the project
root. The loader accepts pure `orchestrator.config.json` and legacy
`orchestrator.config.js`; if multiple shared files exist, preference is JSONC,
then JSON, then JS. An optional untracked
`orchestrator.config.local.jsonc` (or `.json`) is layered on top for
personal/machine-specific overrides — keep shared defaults out of it.

The shipped config carries a `$schema` reference to
`references/orchestrator-config.schema.json` for editor autocomplete and
validation; discover optional settings through completion rather than
commented-out duplicates.

Key settings:

- **`default_cli`**: worker CLI for spawned agents.
- **`orchestrator_cli`**: optional CLI used by the background loop for request
  arbitration. Defaults to `default_cli`.
- **`cli_templates`**: spawn templates for each CLI. Prefer structured
  `{ cmd, args }` (runs with `shell: false`); keep string templates only when
  you need shell behavior. Pin the model here when the CLI supports a
  launch-time flag.
- **`reviewers`**: optional Phase 1.5 plan reviewer CLIs. Each entry needs
  `name`, `cli`, `review_focus`, and optional `model` / `model_flag` /
  `template_args` / `timeout_mins`. Every reviewer CLI must have matching
  `cli_templates.<cli>` and `cli_health_checks.<cli>` entries.
- **`max_plan_review_iterations`**: `"auto"` (default) or a positive integer.
- **`default_timeout_mins`** / **`default_progress_timeout_mins`**: liveness
  and progress thresholds.
- **`default_max_restarts`**: cap on respawns per agent (default 3) across
  validation failures, progress-timeout arbitration, and explicit restarts.
- **`orchestrator_failure_threshold`**: consecutive arbitration-CLI failures
  before the loop writes `coord/orchestrator-stalled.flag` (default 5).
  `claude_failure_threshold` remains a deprecated alias.
- **`poll_min_ms` / `poll_max_ms`**: adaptive polling bounds (defaults 1000 /
  15000). `--poll-interval <ms>` on the loop forces a fixed cadence.
- **`cli_health_checks`**: per-CLI probe commands. Defaults to `<cli> --version`.
- **`launch_dashboard` / `launch_review_terminal`**: optional GUI terminal
  auto-launch. `launch_dashboard` defaults to `"auto"` (macOS local on, CI/SSH/
  non-macOS off).

Example:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/references/orchestrator-config.schema.json",
  "default_cli": "kilo",
  "cli_templates": {
    "claude": { "cmd": "claude", "args": ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--model", "claude-sonnet-4-6"], "stdin": { "prompt_file": true } },
    "codex": { "cmd": "codex", "args": ["exec", "--dangerously-bypass-approvals-and-sandbox"], "stdin": { "prompt_file": true } },
    "gemini": { "cmd": "gemini", "args": ["--prompt", "", "--yolo", "--output-format", "stream-json"], "stdin": { "prompt_file": true } },
    "kilo": { "cmd": "kilo", "args": ["run", "--file", { "prompt_file": true }, "Follow the instructions in the attached prompt file.", "--auto"] },
    "opencode": { "cmd": "opencode", "args": ["run", "--dangerously-skip-permissions", "--file", { "prompt_file": true }, "Follow the instructions in the attached prompt file."] }
  }
}
```

If no shared or local config exists, evaluate the project's size and complexity
to pick sensible defaults (a small script might use 5-minute progress timeouts
and 3 iterations; a complex app might need 20 minutes and 10). Offer to create
the shared config so the user can customize it later.

> Worker CLIs are launched with bypass-permission flags
> (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
> `--yolo`, `--auto`) so they run fully autonomously. The loop remembers which
> CLI spawned each agent and uses the same CLI on respawn.

## Phase 0 — Preflight

```bash
node <SKILL>/scripts/preflight.js
```

Runs unconditionally on every invocation. Reads
`orchestrator.config.jsonc` (then layered local override), prints a model
heads-up (pinned templates by name, unpinned templates called out, reviewer
overrides listed), and probes each CLI twice: a `--version` install check and
an auth probe that exercises the spawn template with a tiny prompt. Use
`--skip-auth` for install-only checks (CI/offline). On failure, abort and
surface the diagnostic — typical fixes are installing the CLI, putting it on
`$PATH`, signing in, or selecting a default model.

## Phase 1 — Task evaluation, topology, and decomposition

Evaluate whether the user's task is suitable for multi-agent orchestration.
Choose an execution topology before decomposing:

- `direct`: small or tightly coupled sequential work. Stop using this skill;
  handle it in the caller session.
- `single_worker`: substantial sequential work that benefits from delegated
  background execution. One task.
- `parallel`: genuinely independent boundaries with non-overlapping file
  ownership and worker-specific validation.
- `phased`: shared foundations must come first, then independent leaves fan
  out. **Implement and commit the foundation in the caller session before
  writing the final task map** — otherwise parallel worktrees will try to
  modify the same files and produce impossible merge conflicts. Common
  foundation files: `package.json`, generic `types.ts`, test config, database
  schemas, router setups.

Record the candidate topology before decomposition: `execution_mode`, rejected
alternatives with reasons, `reason`, `dependency_notes`, shared-foundation
notes, machine-readable `foundation` state, and the mode-specific task
decomposition. Treat the topology as a candidate until after optional Phase
1.5 review and reconciliation.

For each `single_worker` / `parallel` / `phased` task:

1. Carve non-overlapping agent boundaries.
2. Map the files each agent may touch (`allowed_paths`, `forbidden_paths`).
3. List `read_first` files for targeted source context.
4. Fill the `foundation` block: `not_required` (empty paths),
   `completed_committed` (paths + commit), or `owned_by_worker` (paths + owner).
5. Pick a `validation_command`. **Prefer JSON-argv form** so the loop runs it
   with no shell expansion (`--validate '["npm","run","test","--","src/foo"]'`);
   fall back to a shell string only when you need pipes/`&&`/env expansion.
   `null` disables validation.
6. Map agent names to task descriptions.

### Guided helper

```bash
node <SKILL>/scripts/prepare-run.js \
  --project "Short project description" \
  --task "The user's requested implementation" \
  --coord ./coord
```

Default mode runs preflight, bootstraps `coord/` if needed, writes
`coord/plan-reviews/draft-plan-v1.json` (caller-authored template) plus
`draft-plan-v1.instructions.md`, then stops. Replace every TODO placeholder,
choose the topology, define worker boundaries, and review the draft.

After approval:

```bash
node <SKILL>/scripts/prepare-run.js \
  --approve-draft \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

Approval mode materializes `context.json`, `DECISIONS.md`, and
`CALLER_CONTEXT.md`, validates the generated context, and prints the final
`launch-all.js` command. It does not launch workers automatically.

## Phase 1.5 — Optional plan review

If `reviewers` is configured, draft the decomposition as
`coord/plan-reviews/draft-plan-v1.json` before writing the final task map. The
caller session normally writes the draft directly. Run one read-only review
iteration:

```bash
node <SKILL>/scripts/review-plan.js \
  --iteration 1 \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

The runner invokes all configured reviewers in parallel and writes:

- live reviewer streams to `coord/plan-reviews/iteration-<N>/<reviewer>.md`;
- parsed valid reviewer JSON to `coord/plan-reviews/iteration-<N>/<reviewer>.json`;
- the draft audit copy to `coord/plan-reviews/draft-plan-v<N>.json`.

Each reviewer must return JSON with `iteration`, `reviewer`, `summary`,
`execution_mode_issues`, `blockers`, `overlaps`, `missing_foundation_work`,
`sequencing_risks`, `validation_gaps`, and `suggested_changes`. Reviewers
critique both the execution mode and the resulting decomposition (too heavy,
too weak, incorrectly sequenced, parallel-that-should-be-phased,
single_worker/direct that would avoid coordination overhead, unsafe
boundaries). Invalid JSON is a reviewer failure but the workflow continues if
at least one reviewer returns valid JSON.

After every iteration, the main caller writes
`coord/plan-reviews/iteration-<N>/reconciliation.json` (accepted/rejected
feedback plus rationale). Reviewer feedback informs the final decomposition;
reviewers never mutate `coord/context.json` or `coord/DECISIONS.md` directly.

If `max_plan_review_iterations` is a positive integer, run exactly that many
iterations, writing `draft-plan-v<N+1>.json` and passing the prior
reconciliation:

```bash
node <SKILL>/scripts/review-plan.js \
  --iteration 2 \
  --draft-plan ./coord/plan-reviews/draft-plan-v2.json \
  --previous-reconciliation ./coord/plan-reviews/iteration-1/reconciliation.json \
  --coord ./coord
```

If `max_plan_review_iterations` is `"auto"`, run at least one iteration and
then explicitly decide whether another pass is worth it. The runner never
self-continues. Reviewers do not chat with each other; the main caller owns
synthesis. Only after the final iteration is reconciled should you write the
final `coord/context.json` and update `coord/DECISIONS.md`.

`prepare-run.js --approve-draft` materializes the approved draft into the
launchable files (see [appendix](#power-user-appendix) for the standalone
`materialize-plan.js` invocation).

## Phase 2 — Coordination files

`prepare-run.js` (canonical entry) writes the `coord/` skeleton and, after
approval, materializes the final files. Standalone `bootstrap.js` is available
in the appendix when you only want the skeleton.

### `coord/context.json`

The background loop has zero access to your original chat history. Heavily
compress user preferences, architectural nuances, and conversational context
into a structured `chat_context` object. `context.json` is serialized into
arbitration prompts — keep it compact. Long specs, transcripts, file contents,
and diffs do not belong here.

Include the final execution topology, machine-readable foundation contract,
and the per-agent task map under `"tasks"`. If the final mode is `direct`, do
not create or launch an orchestrated run.

```json
{
  "project": "<one-line description of the user's task>",
  "chat_context": {
    "preferences": ["<e.g., Use explicit typing>"],
    "architecture": ["<e.g., MVVM pattern>"],
    "naming_conventions": ["<e.g., camelCase for variables>"],
    "gotchas": ["<e.g., User is using an older version of Node>"]
  },
  "execution_topology": {
    "execution_mode": "<single_worker | parallel | phased>",
    "reason": "<why this topology is the right amount of orchestration>",
    "dependency_notes": ["<shared foundations already committed, fan-out dependencies, or sequencing constraints>"]
  },
  "foundation": {
    "status": "<not_required | completed_committed | owned_by_worker>",
    "paths": ["<shared foundation path/glob, empty when not_required>"],
    "commit": "<required git commit/revision when completed_committed>",
    "owner": "<required task name when owned_by_worker>"
  },
  "requirements": ["<compact requirement summary>"],
  "constraints": ["<compact constraint summary>"],
  "created_at": "<ISO 8601 timestamp>",
  "tasks": {
    "agent-name": {
      "description": "description of the boundary",
      "read_first": ["src/path/to/read.ts"],
      "allowed_paths": ["src/owned/**"],
      "forbidden_paths": ["package.json", "coord/"],
      "validation_command": ["npm", "test", "--", "owned"],
      "timeout_mins": 10,
      "progress_timeout_mins": 15
    }
  }
}
```

### `coord/DECISIONS.md`

Curated source of truth for durable requirements, shared API contracts, data
models, file ownership, and structural decisions made in Phase 1. The
background loop includes `DECISIONS.md` in arbitration prompts, preserves
approved/rejected request dispositions in `coord/decisions.jsonl`, and keeps
the latest 30 in `coord/decisions.json`. It does not rewrite `DECISIONS.md`.
If a runtime approval should become durable project policy, update
`DECISIONS.md` from the orchestrator session.

### `coord/CALLER_CONTEXT.md`

Human-readable file for compressed user intent, important chat nuance, local
environment assumptions, and temporary planning rationale that should not
become durable project policy. The background loop includes it in arbitration
prompts and worker restart prompts; workers are instructed to read it after
`DECISIONS.md`. Stable architecture contracts and file ownership belong in
`DECISIONS.md`, not here.

## Phase 3 — Prompt generation

Prompts render automatically in Phase 4. `launch-all.js` reads
`references/worker-prompt-template.md` and substitutes the placeholders
defined in `references/schemas.md` from each agent's `tasks{}` record. Ensure
every agent record is fully populated before launch.

## Phase 4 — Launch

```bash
node <SKILL>/scripts/launch-all.js --coord ./coord
```

`launch-all.js` runs the shared `validateContext` check against
`coord/context.json` and aborts before any worktree is created if the context
is not launchable. When validation passes, it iterates every entry under
`tasks{}`, creates a git worktree at `.kilocode/worktrees/<agent>` (Kilo) or
`.agents/worktrees/<agent>` (other CLIs), renders the worker prompt, writes
the rendered prompt to a tmp file, and shells out to `scripts/spawn-agent.js`.
After every spawn succeeds, it backgrounds `scripts/orchestrator-loop.js` with
`nohup` and exits non-blocking.

Use `--resume` (alias: `--force-existing-worktrees`) to reuse preserved
worktrees after an abort. In resume mode, existing worktree paths are reused
only after Git confirms the path is a registered worktree checked out on the
expected agent branch; prompts are re-rendered from the current `context.json`
and workers are respawned. Without `--resume`, launch refuses existing
worktree paths.

On success the script prints one summary line per agent (name, PID, log path),
the orchestrator loop PID, and a dashboard hint. On failure it stops the loop,
leaves already-spawned agents alive for inspection, and exits non-zero.

**Once the loop is started, the starter session's job is done.** Tell the user
the loop is running in the background, then exit.

> **Kilo Code users:** because agents spawn under `.kilocode/worktrees/`, they
> appear in the Kilo Code Agent Manager UI inside VS Code and you can monitor
> per-file edits in real time.

### Monitoring

The dashboard auto-launches on local macOS by default. To check status from
any caller, use the canonical probe:

```bash
node <SKILL>/scripts/status.js --coord ./coord            # human
node <SKILL>/scripts/status.js --coord ./coord --json     # machine-readable
```

`status.js` reports `loop_state`, agents (status, last event sequence,
blockers), and surfaces `coord/orchestrator-stalled.flag` /
`coord/abort.flag`. It is safe to run before, during, or after a run.

### Progress monitoring (loop internals)

- **Liveness timeout.** No log output for `timeout_mins` → the agent is killed
  and marked errored.
- **Progress timeout.** Logs flow but no git commits or unstaged diff for
  `progress_timeout_mins` → the loop writes a synthetic `progress_timeout`
  request into `coord/requests.jsonl` for normal arbitration.
- **Progress heartbeat (optional).** Workers may write
  `coord/progress/<agent>.json` via atomic rename. The loop uses filesystem
  mtime as the wall-clock signal (models are not expected to perceive elapsed
  time). A fresh heartbeat in a non-editing phase (`reading`, `planning`,
  `testing`, `building`, `installing`, `debugging`) can grant one bounded
  progress grace after the last code change.
- **Synthetic timeout requests** carry a deterministic recommended
  instruction, escalation fields (`escalation_level`, `progress_timeout_count`,
  `restart_count`, `restarts_remaining`, `suggested_action`), task context,
  validation command, heartbeat snapshot, diff snapshot, and the last 50 log
  lines. Existing arbitration decides `soft_restart` / `hard_restart` / wait /
  reject.
- **Escalation ladder.** First timeout → `soft_restart`; second → stronger
  `soft_restart`; third+ → `hard_restart` unless a recovery tag exists or the
  budget is exhausted. The arbitrator makes the final call.

### Action types

| Action | Effect |
|--------|--------|
| `end_agent` | Loop runs the agent's `validation_command` (if configured) in its worktree. Pass → auto-commits any uncommitted work (`git add -A` + `git commit -m "agent-<name>: <task>"`), SIGTERMs, marks `"completed"`. Fail → triggers an automatic `soft_restart` with stderr/stdout fed back. |
| `soft_restart` | Loop kills the process, makes a `WIP` commit to preserve uncommitted work, respawns with new `instruction`s (e.g. test failures or arbitration guidance). |
| `hard_restart` | Loop kills the process, captures uncommitted+untracked work as a `recovery/<agent>/<timestamp>` git tag, resets the worktree clean, respawns. The tag preserves the wiped state for `git show <tag>` recovery. |

**Restart cap.** Every restart increments `restart_count`. Past
`default_max_restarts` (default 3), the loop stops respawning and marks the
agent `errored`.

**PID/process-group safety.** Before signalling, the loop validates the stored
PID still matches the worker CLI's cmdline (POSIX `ps`). On POSIX, workers
launch as detached process groups so stops/restarts hit the whole group.

**Aborting.** Closing the dashboard window leaves agents running. Pressing
Ctrl+C asks for confirmation, then writes `coord/abort.flag`. The loop's abort
path kills running agent processes and marks them `terminated` but **does
not** `git reset --hard` worktrees and **does not** delete `coord/`. In-flight
work is preserved (`git status` in each worktree); `coord/logs/`,
`events.jsonl`, requests, and decisions remain for diagnosis. To continue,
inspect preserved changes, update `context.json` if needed, then
`launch-all.js --coord ./coord --resume`.

**Stalled-CLI surfacing.** If the orchestrator CLI fails
`orchestrator_failure_threshold` cycles (default 5), the loop writes
`coord/orchestrator-stalled.flag` with a diagnostic. The dashboard and
`status.js` surface this. The flag is cleared automatically on the first
successful cycle.

**Event log.** Every state transition (`spawn-agent.js` and
`orchestrator-loop.js` both write) appends a JSON line to `coord/events.jsonl`.
Best-effort, append-only — the canonical chronological audit trail.

## Phase 5 — Review and integration

When all workers finish, `orchestrator-loop.js` automatically:

1. **Aggregates worker self-reports** from `agents.json` and each worker's
   resolved `review_request` content.
2. **Writes `coord/review-summary.txt`** deterministically (no AI call).
3. **Optionally opens a popup terminal** with the summary if
   `launch_review_terminal` is enabled.
4. **Exits.**

The user returns to the interactive orchestrator session — either the original
chat window or a new one — and gives an instruction like *"The agents are
done. Please review and integrate."* Then:

1. Identify completed worktrees (look in `.kilocode/worktrees/` and
   `.agents/worktrees/`).
2. Run `git diff main...<agent-name>` for each.
3. Summarize the work for the user.
4. After approval, merge:
   ```bash
   git merge <agent-name>
   git worktree remove <worktree-path>/<agent-name>
   git branch -d <agent-name>
   ```

## Power-user appendix

Alternative entry points that preserve capability but are not the canonical
recommended path.

### Direct bootstrap (skip `prepare-run.js`)

```bash
node <SKILL>/scripts/bootstrap.js \
  --project "Your project description" \
  --coord ./coord
```

`bootstrap.js` only scaffolds an empty skeleton (`chat_context: {}`,
`execution_topology: { execution_mode: "", reason: "", dependency_notes: [] }`,
`foundation: { status: "", paths: [] }`, `tasks: {}`). After running it, edit
`context.json` to populate the structured shape above, or run
`scripts/materialize-plan.js` from an approved draft before launch.
`bootstrap.js` refuses to overwrite existing coordination state by default —
use `--force` only when intentionally discarding the current run state.

### Read-only draft helper

```bash
node <SKILL>/scripts/draft-plan.js \
  --task "The user's requested implementation" \
  --project "Short project description" \
  --coord ./coord
```

Uses `orchestrator_cli` (falls back to `default_cli`) to produce
`coord/plan-reviews/draft-plan-v1.prompt.md`, `draft-plan-v1.raw.md`, and the
canonical `draft-plan-v1.json`. Read-only — does not launch workers or edit
project files. The caller still owns review and approval.

### Standalone materializer

```bash
node <SKILL>/scripts/materialize-plan.js \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

Preserves existing compact `chat_context`, writes the final execution
topology, foundation contract, and task map to `context.json`, writes durable
rationale to `DECISIONS.md`, writes non-durable rationale to
`CALLER_CONTEXT.md`, then validates the generated context. Refuses to
overwrite an existing non-empty task map unless `--force` is passed. If the
final topology is `direct`, it writes no worker tasks and tells the caller not
to run `launch-all.js`.

### Standalone context validator

```bash
node <SKILL>/scripts/validate-context.js --coord ./coord
```

Checks execution topology, foundation status, committed foundation
cleanliness, per-task name safety, allowed/forbidden path shape, CLI
references against `cli_templates`, and common foundation-path leaks.
`materialize-plan.js`, `prepare-run.js --approve-draft`, and `launch-all.js`
all call the same validator internally. Useful as a standalone safety check
after hand-edits to `context.json`. `--json` prints a machine-readable report.

### Manual dashboard launch

```bash
node <SKILL>/scripts/dashboard.js --coord ./coord
```

Opens the TUI dashboard. Auto-launched on local macOS by default. Outside
macOS / over SSH / in CI, run manually.

### Spawn-agent passthrough

`scripts/spawn-agent.js` supports `--`. Arguments after `--` are appended
directly to the CLI command template defined in `orchestrator.config.jsonc`.

> **Warning:** `--` arguments are NOT sanitized — they are appended as-is to
> the shell command or argv list. Use only for temporary debugging
> (`-- --verbose`, `-- --model <other-id>`) or project-specific overrides that
> don't warrant a permanent config change.

## For maintainers

Run `node scripts/run-tests.js` to syntax-check scripts and execute
dependency-free smoke tests.
