[English](./README.md) | [简体中文](./README_zh-CN.md)

# Multi-Agent Orchestrator

Run parallel coding agents safely with git worktree isolation, scoped prompts, validation, restarts, and multi-CLI support.

Multi-Agent Orchestrator is an Agent Skill and dependency-free Node.js runtime for coordinating multiple headless coding agents on one repository. It splits large tasks into isolated git worktrees, gives every worker explicit file ownership, supervises progress, restarts stuck agents, runs validation commands, and writes a deterministic final handoff summary for review and merge.

Use it from Claude Code, Codex, Gemini CLI, or any other local coding agent that can read `SKILL.md` and run shell commands.

<!-- Dashboard screenshot/GIF placeholder:
![Dashboard showing parallel worker status](docs/assets/dashboard.png)
-->

## What It Coordinates

- **Worker agents** implement scoped subtasks in isolated git worktrees.
- **Reviewer agents** can critique the decomposition before workers launch.
- **The background loop** supervises workers, handles questions, detects stalls, restarts failed agents, and runs validation commands.
- **The caller session** stays responsible for architecture, shared foundations, final diff review, and merge decisions.

Key capabilities:

- Splits large implementation work across multiple coding agents.
- Keeps durable requirements, architecture, contracts, and file ownership in `coord/DECISIONS.md`.
- Stores compact run context and per-agent task boundaries in `coord/context.json`.
- Preserves caller-session nuance in `coord/CALLER_CONTEXT.md` so the background loop does not need hidden chat history.
- Supervises liveness, progress, validation, restarts, and worker questions.
- Provides a live terminal dashboard.
- Produces a deterministic `coord/review-summary.txt` from worker self-reports for final integration.
- Supports Claude Code, Codex, Gemini CLI, and other CLIs such as Kilo Code, OpenCode, or custom adapters.

## When To Use It

Use this when a task is large enough to split into independent workstreams, such as:

- building several independent app surfaces;
- implementing separate backend, frontend, test, and migration tracks;
- running cleanup or migration tasks across different modules;
- assigning parallel investigation or repair tasks to isolated workers.

Skip orchestration for small changes, tightly coupled edits, or work that repeatedly touches the same shared files. Handle shared foundations first in the main worktree, commit them, then fan out parallel worker tasks.

## Safety Notes

The runtime isolates workers with git worktrees, but the selected worker CLI still edits files and may run commands according to its own permissions. The shipped templates use each CLI's autonomous or permission-bypass mode so background workers do not block on prompts.

Use this only in repositories where you are comfortable reviewing and reverting generated changes. Always review worker diffs before merging. The orchestrator is a coordination tool, not a replacement for code review.

## Prerequisites

- Node.js.
- Git with worktree support.
- A target project that is already a git repository.
- At least one supported worker CLI installed, authenticated, and configured with a default model.

The runtime has no package dependencies. There is no `npm install`, no `node_modules`, and no build step.

Workers run non-interactively. Any selected CLI must already be signed in and able to answer a tiny prompt without setup prompts.

## Install

Set `ORCHESTRATOR_HOME` to the installed repo path. The quick-start commands below use that variable.

### Claude Code

```bash
git clone https://github.com/hyw007726/multi-agent-orchestrator-skill.git \
  ~/src/multi-agent-orchestrator

mkdir -p ~/.claude/skills
ln -s ~/src/multi-agent-orchestrator \
  ~/.claude/skills/multi-agent-orchestrator

export ORCHESTRATOR_HOME="$HOME/src/multi-agent-orchestrator"
```

### Codex

```bash
curl -fsSL https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/install-codex.sh | sh
export ORCHESTRATOR_HOME="${CODEX_HOME:-$HOME/.codex}/skills/multi-agent-orchestrator"
```

Restart Codex after installing. Running the installer again updates the skill.

### Gemini CLI

```bash
git clone https://github.com/hyw007726/multi-agent-orchestrator-skill.git \
  ~/src/multi-agent-orchestrator

gemini extensions install ~/src/multi-agent-orchestrator

export ORCHESTRATOR_HOME="$HOME/src/multi-agent-orchestrator"
```

The extension exposes `/multi-agent-orchestrator`.

### Manual Use

Any local coding agent can use the runtime directly:

```text
Read /path/to/multi-agent-orchestrator/SKILL.md and use that workflow from this project.
```

## Quick Start

From the target project you want agents to work on, run preflight:

```bash
cd /path/to/target-project
node "$ORCHESTRATOR_HOME/scripts/preflight.js"
```

Then ask your caller agent to use the orchestrator.

For Claude Code or another local caller:

```text
Read /path/to/multi-agent-orchestrator/SKILL.md and use that workflow to split this implementation:

<describe the large feature or migration>
```

For Codex:

```text
Use $multi-agent-orchestrator to split this implementation into parallel worker agents:

<describe the large feature or migration>
```

For Gemini CLI:

```text
/multi-agent-orchestrator split this implementation into parallel worker agents:

<describe the large feature or migration>
```

The caller session will:

1. choose an execution topology: `direct`, `single_worker`, `parallel`, or `phased`;
2. handle shared foundation files first;
3. draft the topology-aware decomposition;
4. create or update `coord/context.json`, `coord/DECISIONS.md`, and `coord/CALLER_CONTEXT.md`;
5. launch worker worktrees and the background supervision loop;
6. review final diffs and merge approved worker output.

## Guided Starter Command

For the common starter-session path, run this from the target project root:

```bash
node "$ORCHESTRATOR_HOME/scripts/prepare-run.js" \
  --project "Build the requested feature" \
  --task "Build the requested feature" \
  --coord ./coord
```

This runs preflight, bootstraps `coord/` when needed, writes a draft plan template, and stops for caller review. After editing the draft, materialize it with:

```bash
node "$ORCHESTRATOR_HOME/scripts/prepare-run.js" \
  --approve-draft \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

The approval step writes the final coordination files, validates `context.json`, and prints the `launch-all.js` command. It does not launch workers for you.

## Common Commands

Run from the target project root.

```bash
# Verify configured worker, orchestrator, and reviewer CLIs.
node "$ORCHESTRATOR_HOME/scripts/preflight.js"

# Validate context.json before creating worktrees.
node "$ORCHESTRATOR_HOME/scripts/validate-context.js" --coord ./coord

# Launch worker worktrees and the background loop.
node "$ORCHESTRATOR_HOME/scripts/launch-all.js" --coord ./coord

# Resume preserved worktrees after an inspected abort.
node "$ORCHESTRATOR_HOME/scripts/launch-all.js" --coord ./coord --resume

# Open the live dashboard.
node "$ORCHESTRATOR_HOME/scripts/dashboard.js" --coord ./coord
```

Most users should let the caller agent run these commands after it has read `SKILL.md`.

## How It Works

1. The interactive caller session acts as architect. It chooses the execution topology, decomposes the task, resolves shared foundations, assigns file ownership, and gives each worker a `read_first` file/path list.
2. `scripts/prepare-run.js` or `scripts/bootstrap.js` initializes `coord/`, the state directory shared by the caller, workers, and background loop.
3. `scripts/materialize-plan.js` converts an approved draft into compact `coord/context.json`, durable `coord/DECISIONS.md`, and human-readable `coord/CALLER_CONTEXT.md`.
4. `scripts/launch-all.js` validates context, creates one git worktree per agent, renders prompts from `references/worker-prompt-template.md`, spawns workers, and starts the background loop.
5. `scripts/orchestrator-loop.js` arbitrates questions, reads optional progress heartbeats, converts progress timeouts into arbitration requests, detects hung workers, restarts within limits, and runs validation commands.
6. When all workers finish, the loop writes `coord/review-summary.txt` from worker self-reports.
7. The caller session reviews diffs, runs final checks, merges approved work, and removes completed worktrees.

Abort handling is intentionally inspectable: a confirmed dashboard abort stops running worker processes and marks them `terminated`, but it preserves worker worktrees and `coord/` logs, events, requests, and decisions for diagnosis.

## Runtime Files

| Path | Purpose |
| --- | --- |
| `coord/context.json` | Compact run context, execution topology, task map, `read_first` hints, and worker boundaries. |
| `coord/DECISIONS.md` | Human-readable source of truth for durable requirements, architecture, APIs, ownership, and constraints. |
| `coord/CALLER_CONTEXT.md` | Human-readable caller-session context included in arbitration and worker restart prompts. |
| `coord/agents.json` | Current worker state. |
| `coord/decisions.json` / `coord/decisions.jsonl` | Recent decisions plus append-only decision audit log. |
| `coord/events.jsonl` | Append-only structured event log. |
| `coord/progress/<agent>.json` | Optional worker heartbeat. |
| `coord/plan-reviews/` | Optional draft plans, reviewer streams, parsed reviewer JSON, and caller reconciliations. |
| `coord/review-summary.txt` | Deterministic final handoff summary. |
| `.agents/worktrees/<agent>` | Worker git worktrees for most CLIs. |
| `.kilocode/worktrees/<agent>` | Worker git worktrees for Kilo Code. |

## Configuration

The runtime reads `orchestrator.config.jsonc` from the target project root. Pure `orchestrator.config.json` and legacy executable `orchestrator.config.js` are also accepted. If multiple shared files exist, the loader prefers JSONC, then JSON, then JS.

For personal machine-specific overrides, create untracked `orchestrator.config.local.jsonc` only when needed.

Minimal override:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/references/orchestrator-config.schema.json",
  "default_cli": "kilo",
  "default_timeout_mins": 10,
  "default_progress_timeout_mins": 15,
  "default_max_restarts": 3
}
```

Important settings:

- `default_cli`: worker CLI for coding tasks.
- `orchestrator_cli`: optional CLI for request arbitration. If omitted, it follows `default_cli`.
- `cli_templates`: command templates for supported or custom CLIs.
- `cli_health_checks`: lightweight install checks used by preflight.
- `reviewers`: optional read-only plan reviewer CLI agents.
- `default_timeout_mins`: liveness timeout when logs stop.
- `default_progress_timeout_mins`: progress timeout when logs continue but code does not change.
- `default_max_restarts`: restart cap per agent.
- `launch_dashboard`: dashboard auto-launch behavior.

The repository root includes a fuller `orchestrator.config.jsonc`, and `references/orchestrator-config.schema.json` provides editor autocomplete and validation.

## Worker Model Selection

Keep model selection attached to the CLI mechanism that launches the worker:

- CLIs that support launch-time model flags should pin models in `cli_templates.<cli>`.
- CLIs that do not support launch-time model flags should select models in that CLI's own provider/model settings.
- Per-worker model differences should use CLI aliases, then assign `tasks.<name>.cli` to the desired alias.

The preflight output reports pinned models when visible and calls out unpinned CLIs that rely on their own config/defaults.

## Supported Worker CLIs

Built-in templates are provided for:

- `claude`
- `codex`
- `gemini`
- `kilo`
- `opencode`

Custom CLIs are supported by adding both `cli_templates.<name>` and `cli_health_checks.<name>` in `orchestrator.config.jsonc`. The runtime does not guess a fallback command shape for custom CLIs.

## Development

Run the default test suite:

```bash
node scripts/run-tests.js
```

The tests use fake CLIs against temporary git repositories, so they do not require real worker credentials.

Live model tests are opt-in because they call authenticated provider CLIs and may use paid model calls. See [docs/live-model-tests.md](docs/live-model-tests.md).

## More Docs

- [SKILL.md](SKILL.md): canonical workflow for caller agents.
- [references/schemas.md](references/schemas.md): coordination file and prompt schema details.
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution guidelines.
- [SECURITY.md](SECURITY.md): vulnerability reporting and security scope.

## Listing This Project

If you add this repo to a catalog or awesome list, use:

```markdown
- **[hyw007726/multi-agent-orchestrator-skill](https://github.com/hyw007726/multi-agent-orchestrator-skill)** - Parallel coding agents in isolated git worktrees.
```

Suggested GitHub topics:

```text
agent-skills, claude-code, codex-skills, codex-cli, gemini-cli, ai-agents, coding-agents, multi-agent-systems, agent-orchestration, git-worktrees
```
