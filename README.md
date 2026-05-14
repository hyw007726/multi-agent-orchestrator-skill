# Multi-Agent Orchestrator

Run several coding agents on one repository without letting them collide.

Multi-Agent Orchestrator is an Agent Skill and dependency-free Node.js runtime for splitting large coding tasks into parallel headless workers. It creates isolated git worktrees, gives every worker a scoped prompt and file boundary, supervises progress, restarts stuck agents, runs validation commands, and writes a deterministic final handoff summary so your interactive session can merge the results.

Use it from Codex, Gemini CLI, Claude Code, or any local coding agent that can read `SKILL.md` and run shell commands.

## What It Does

- Splits large implementation work across multiple coding agents.
- Runs each worker in its own git worktree.
- Keeps durable requirements, shared architecture, contracts, and file ownership in `coord/DECISIONS.md`.
- Stores compact run context and per-agent task boundaries in `coord/context.json`.
- Preserves caller-session nuance and runtime assumptions in `coord/CALLER_CONTEXT.md` so the headless loop does not need the original chat.
- Supervises liveness, progress, validation, restarts, and worker questions.
- Supports optional worker progress heartbeats and converts repeated no-diff stalls into escalating arbitration requests instead of launching a separate review model call.
- Provides a live terminal dashboard.
- Produces a deterministic `coord/review-summary.txt` from worker self-reports for final human/agent integration.
- Supports Kilo Code, Aider, Claude Code, Codex, Gemini CLI, OpenCode, and custom CLIs.

## When To Use It

Use this when a task is large enough to split into independent workstreams, such as:

- building several independent app surfaces;
- implementing separate backend, frontend, test, and migration tracks;
- running many cleanup or migration tasks across different modules;
- assigning parallel investigation or repair tasks to isolated workers.

Do not use it for small changes, tightly coupled edits, or work that depends on one shared file being changed repeatedly. Handle shared foundations first in the main worktree, commit them, then fan out parallel worker tasks.

## Install

### Codex

Run one command:

```bash
curl -fsSL https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/install-codex.sh | sh
```

Then restart Codex. Running the same command later updates the skill.

The installer clones this repo into:

```bash
${CODEX_HOME:-$HOME/.codex}/skills/multi-agent-orchestrator
```

### Gemini CLI

Clone the repo, then install it as a Gemini extension:

```bash
git clone https://github.com/hyw007726/multi-agent-orchestrator-skill.git \
  ~/src/multi-agent-orchestrator

gemini extensions install ~/src/multi-agent-orchestrator
```

The extension exposes `/multi-agent-orchestrator`.

### Claude Code

Clone the repo, then symlink it into Claude skills:

```bash
git clone https://github.com/hyw007726/multi-agent-orchestrator-skill.git \
  ~/src/multi-agent-orchestrator

mkdir -p ~/.claude/skills
ln -s ~/src/multi-agent-orchestrator \
  ~/.claude/skills/multi-agent-orchestrator
```

### Manual Use

Any local coding agent can use the runtime directly:

```text
Read ~/src/multi-agent-orchestrator/SKILL.md and use that workflow from this project.
```

## Prerequisites

- Node.js.
- Git with worktree support.
- A target project that is already a git repository.
- At least one supported worker CLI installed, authenticated, and configured with a default model.

The runtime has no package dependencies. There is no `npm install`, no `node_modules`, and no build step.

Workers run non-interactively. Any selected CLI must already be signed in and able to answer a tiny prompt without setup prompts.

## Quick Start

From the target project you want agents to work on, run preflight:

```bash
node ~/.codex/skills/multi-agent-orchestrator/scripts/preflight.js
```

If you installed somewhere else, replace `~/.codex/skills/multi-agent-orchestrator` with that path.

Then ask your caller agent to use the orchestrator:

```text
Use $multi-agent-orchestrator to split this implementation into parallel worker agents:

<describe the large feature or migration>
```

For Gemini CLI, use `/multi-agent-orchestrator`. For other callers, ask them to read this repo's `SKILL.md`.

The caller session will:

1. choose an execution topology: `direct`, `single_worker`, `parallel`, or `phased`;
2. handle shared foundation files first;
3. draft the topology-aware decomposition in the caller session, then run optional read-only plan reviewers if configured;
4. create or update compact `coord/context.json` plus durable `coord/DECISIONS.md`;
5. split the remaining work into non-overlapping agent tasks;
6. launch the workers and the background supervision loop.

Use `direct` for small or tightly coupled tasks and skip orchestration. Use `single_worker` for substantial sequential work, `parallel` for genuinely independent worker boundaries, and `phased` when shared foundations must be handled first before worker fan-out.

## Common Commands

Run from the target project root.

```bash
# Verify configured worker, orchestrator, and reviewer CLIs are installed and authenticated.
node /path/to/multi-agent-orchestrator/scripts/preflight.js

# Bootstrap coord/ state for a new orchestrated run.
# Refuses existing coordination state unless --force is passed.
node /path/to/multi-agent-orchestrator/scripts/bootstrap.js \
  --project "Build the requested feature" \
  --coord ./coord

# Optional: ask the configured orchestrator CLI for a read-only draft helper.
node /path/to/multi-agent-orchestrator/scripts/draft-plan.js \
  --task "Build the requested feature" \
  --project "Build the requested feature" \
  --coord ./coord

# Optional: run one read-only plan-review iteration before finalizing context.json.
node /path/to/multi-agent-orchestrator/scripts/review-plan.js \
  --iteration 1 \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord

# Convert the approved draft plan into coord/context.json, coord/DECISIONS.md, and coord/CALLER_CONTEXT.md.
node /path/to/multi-agent-orchestrator/scripts/materialize-plan.js \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord

# Validate context.json before creating worktrees.
node /path/to/multi-agent-orchestrator/scripts/validate-context.js --coord ./coord

# Launch worker worktrees and the background loop.
node /path/to/multi-agent-orchestrator/scripts/launch-all.js --coord ./coord

# Open the live dashboard.
node /path/to/multi-agent-orchestrator/scripts/dashboard.js --coord ./coord
```

Most users should let the caller agent run these commands after it has read `SKILL.md`.

### Guided Starter Command

For the common starter-session path, use `prepare-run.js` from the target project root:

```bash
node /path/to/multi-agent-orchestrator/scripts/prepare-run.js \
  --project "Build the requested feature" \
  --task "Build the requested feature" \
  --coord ./coord
```

This runs preflight, bootstraps `coord/` when needed, writes `coord/plan-reviews/draft-plan-v1.json` as a caller-authored template, writes `draft-plan-v1.instructions.md`, and then stops. The caller session must fill in and review the draft before approval. After editing the draft, materialize it with:

```bash
node /path/to/multi-agent-orchestrator/scripts/prepare-run.js \
  --approve-draft \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

The approval step writes `context.json`, `DECISIONS.md`, and `CALLER_CONTEXT.md`, validates `context.json`, and prints the final `launch-all.js` command. It does not launch workers for you.

## How It Works

1. The interactive caller session acts as architect. It chooses the execution topology, decomposes the task, resolves shared foundations, assigns file ownership, records durable decisions, and gives each worker a `read_first` file/path list.
2. `scripts/bootstrap.js` initializes `coord/`, the state directory shared by the caller, workers, and background loop.
3. The caller writes `coord/plan-reviews/draft-plan-v1.json`; `prepare-run.js` can scaffold a TODO template, and `scripts/draft-plan.js` remains an optional helper that uses `orchestrator_cli`.
4. `scripts/materialize-plan.js` converts an approved draft into compact `coord/context.json`, durable `coord/DECISIONS.md`, and human-readable `coord/CALLER_CONTEXT.md`.
5. `scripts/launch-all.js` validates context, creates one git worktree per agent, renders prompts from `references/worker-prompt-template.md`, spawns workers, and starts the background loop. After an abort that preserves worker worktrees, rerun it with `--resume` to validate and reuse those worktrees while rendering fresh prompts and respawning workers.
6. `scripts/orchestrator-loop.js` supervises workers. It arbitrates questions, reads optional progress heartbeats, converts progress timeouts into synthetic arbitration requests, detects hung workers, restarts within limits, and runs validation commands.
7. When all workers finish, the loop writes a deterministic `coord/review-summary.txt` from `agents.json` and worker `review_request` self-reports.
8. The interactive caller session reviews diffs, runs final checks, merges approved work, and removes completed worktrees.

Abort handling is intentionally inspectable: a confirmed dashboard abort stops running worker processes and marks them `terminated`, but it preserves both worker worktrees and `coord/` logs, events, requests, and decisions for diagnosis. To continue from that state, run `launch-all.js --coord ./coord --resume`; existing worktrees are reused only when Git reports that the path is registered and checked out on the expected agent branch.

## Runtime Files

| Path | Purpose |
| --- | --- |
| `coord/context.json` | Compact run context, final execution topology, task map, `read_first` hints, and worker boundaries. |
| `coord/DECISIONS.md` | Human-readable source of truth for durable requirements, architecture, APIs, ownership, and constraints. |
| `coord/CALLER_CONTEXT.md` | Human-readable caller-session context: user intent, chat nuance, environment assumptions, and non-durable rationale. Included in arbitration and worker restart prompts. |
| `coord/agents.json` | Current worker state. |
| `coord/decisions.json` / `coord/decisions.jsonl` | Bounded recent window (latest 30) of final request dispositions, including approvals and rejections, plus the append-only audit log. |
| `coord/events.jsonl` | Append-only structured event log written by the loop and `spawn-agent.js` (spawns, restarts, recovery tags, heartbeat graces, aborts). |
| `coord/progress/<agent>.json` | Optional worker-written heartbeat with phase, summary, latest action, and blocker context. |
| `coord/plan-reviews/` | Optional Phase 1.5 draft plans, reviewer streams, parsed reviewer JSON, and caller reconciliations. |
| `coord/review-summary.txt` | Deterministic final handoff summary after workers complete. Built from worker review requests; no final AI summary call is made. |
| `.agents/worktrees/<agent>` | Worker git worktrees for most CLIs. |
| `.kilocode/worktrees/<agent>` | Worker git worktrees for Kilo Code. |

## Configuration

The runtime reads `orchestrator.config.jsonc` from the target project root. JSONC is JSON with comments, so configuration stays data-only while still being readable. Pure `orchestrator.config.json` and legacy `orchestrator.config.js` are also accepted; if multiple shared files exist, the loader prefers JSONC, then JSON, then JS.

The shipped config includes a `$schema` reference to the published `references/orchestrator-config.schema.json`. Editors such as VS Code and Cursor use it for autocomplete, descriptions, allowed values, and validation, so users can discover optional settings without scanning commented-out configuration blocks.

For personal machine-specific overrides, create `orchestrator.config.local.jsonc` only when needed. It is gitignored, loaded after the shared config, and should contain only values that differ from the shared defaults. It can be as small as:

```jsonc
{}
```

Example local override:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/references/orchestrator-config.schema.json",
  "default_cli": "codex",
  "launch_dashboard": false
}
```

If no shared or local config file exists, the runtime uses built-in defaults.

## Worker Model Selection

Keep model selection attached to the CLI mechanism that actually launches the
worker:

- CLIs that support a launch-time model flag should pin models in
  `cli_templates.<cli>` by adding that flag, such as `--model <id>` or
  `-m <id>`.
- CLIs that do not support a launch-time model flag should select models in that
  CLI's own provider/model settings. Do not add a generic `default_model` key;
  the runtime intentionally does not define one.
- Per-worker model differences should use CLI aliases. For example, define
  `claude-sonnet-worker` and `claude-fast-worker` as separate
  `cli_templates` / `cli_health_checks` entries, then assign
  `tasks.<name>.cli` to the desired alias.

The preflight output includes a model heads-up and provider-aware fallback
guidance. Current second-tier worker recommendations are advisory and should be
refreshed over time:

- Claude: `claude-sonnet-4-6`
- Codex/OpenAI: `gpt-5.1-codex-mini` or `gpt-5-mini` when the CLI exposes
  general OpenAI models instead of Codex-specific models
- Gemini: `gemini-2.5-flash`

Example inline-flag aliases:

```jsonc
{
  "default_cli": "claude-sonnet-worker",
  "cli_templates": {
    "claude-sonnet-worker": {
      "cmd": "claude",
      "args": ["-p", { "prompt_text": true }, "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6"]
    },
    "gemini-flash-worker": {
      "cmd": "gemini",
      "args": ["--prompt", { "prompt_text": true }, "--yolo", "--model", "gemini-2.5-flash"]
    },
    "codex-mini-worker": {
      "cmd": "codex",
      "args": ["exec", "--model", "gpt-5.1-codex-mini", "--dangerously-bypass-approvals-and-sandbox", { "prompt_text": true }]
    }
  },
  "cli_health_checks": {
    "claude-sonnet-worker": "claude --version",
    "gemini-flash-worker": "gemini --version",
    "codex-mini-worker": "codex --version"
  }
}
```

When a CLI is left unpinned, preflight reports that the exact model is selected
by the CLI's own config/default and is not visible to the orchestrator.

## Live Model Tests

The default test command stays hermetic:

```bash
node scripts/run-tests.js
```

Live model tests are opt-in because they call authenticated provider CLIs, may
use paid model calls, and can fail due to provider, network, auth, or model
behavior. They are not included in `node scripts/run-tests.js`.

Run all currently configured live tests:

```bash
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js
```

Run one provider:

```bash
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider claude
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider gemini
```

The live harness writes provider-specific lower-model aliases for worker,
arbitrator, and reviewer roles. The current live tests cover three isolated
roles:

- reviewer: runs the real `review-plan.js` path and asserts valid reviewer JSON.
- arbitrator: stages a deterministic worker `question` request and asserts the
  live arbitrator resolves it through `requests.jsonl`, `decisions.json`, and
  `decisions.jsonl`.
- worker: launches a real lower-model worker through `launch-all.js`, uses a
  fake local arbitrator for completion approval, and asserts the worker writes
  `live-worker-output.txt`, submits a `review_request`, passes validation, and
  reaches `completed`.

Default live model choices are:

- Codex/OpenAI: `gpt-5.1-codex-mini`
- Claude: `claude-sonnet-4-6`
- Gemini: `gemini-2.5-flash`

Override them globally or per role:

```bash
LIVE_CODEX_MODEL=gpt-5-mini RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
LIVE_CODEX_WORKER_MODEL=gpt-5.1-codex-mini RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
LIVE_CODEX_ARBITRATOR_MODEL=gpt-5.1-codex-mini RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
LIVE_GEMINI_REVIEWER_MODEL=gemini-2.5-flash RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider gemini
```

Set `LIVE_KEEP_ARTIFACTS=1` to preserve the temporary project and review
artifacts for debugging failed live runs.

The most important settings are:

- `default_cli`: worker CLI for coding tasks and cheap monitor calls.
- `orchestrator_cli`: optional CLI for request arbitration. If omitted, it follows `default_cli`.
- `cli_templates`: command templates for supported or custom CLIs.
- `cli_health_checks`: lightweight install checks used by preflight.
- `reviewers`: optional read-only plan reviewer CLI agents for Phase 1.5.
- `max_plan_review_iterations`: `"auto"` or a positive integer for configured plan review passes.
- `default_timeout_mins`: liveness timeout when logs stop.
- `default_progress_timeout_mins`: progress timeout when logs continue but code does not change.
- `default_max_restarts`: restart cap per agent.
- `launch_dashboard`: dashboard auto-launch behavior.

Minimal override example:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/references/orchestrator-config.schema.json",
  "default_cli": "kilo",
  "default_timeout_mins": 10,
  "default_progress_timeout_mins": 15,
  "default_max_restarts": 3
}
```

The repository root includes a fuller `orchestrator.config.jsonc` with all built-in CLI templates and comments.

## Supported Worker CLIs

Built-in templates are provided for:

- `kilo`
- `aider`
- `claude`
- `codex`
- `gemini`
- `opencode`

Custom CLIs are supported by adding both `cli_templates.<name>` and `cli_health_checks.<name>` in `orchestrator.config.jsonc`. The runtime does not guess a fallback command shape for custom CLIs.

## Safety Notes

The runtime isolates workers with git worktrees, but the selected worker CLI still edits files and may run commands according to its own permissions. Review `cli_templates` before using this on sensitive repositories.

The shipped templates use each CLI's autonomous or permission-bypass mode so background workers do not block on prompts. Use this only in repositories where you are comfortable reviewing and reverting generated changes.

Always review worker diffs before merging. The orchestrator is a coordination tool, not a replacement for code review.

## Why Not Just Open More Terminals?

Manual parallel agent runs break down when workers need shared context, durable decisions, restart handling, and a clean integration handoff. This runtime adds the missing coordination layer:

- one compressed context object for every worker;
- explicit file ownership per agent;
- durable decision logs;
- liveness and progress supervision;
- validation-driven restarts;
- a deterministic final handoff summary for the integrating agent.

## Development

Run the test suite:

```bash
node scripts/run-tests.js
```

The tests use fake CLIs against temporary git repositories, so they do not require real worker credentials.

## Listing This Project

If you add this repo to a catalog or awesome list, use:

```markdown
- **[hyw007726/multi-agent-orchestrator](https://github.com/hyw007726/multi-agent-orchestrator-skill)** - Parallel coding agents in isolated git worktrees.
```

Suggested GitHub topics:

```text
agent-skills, codex-skills, codex-cli, ai-agents, coding-agents, multi-agent-systems, agent-orchestration, claude-code, gemini-cli, git-worktrees
```
