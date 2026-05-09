# Multi-Agent Orchestrator

Run several coding agents on one repository without letting them collide.

Multi-Agent Orchestrator is an Agent Skill and dependency-free Node.js runtime for splitting large coding tasks into parallel headless workers. It creates isolated git worktrees, gives every worker a scoped prompt and file boundary, supervises progress, restarts stuck agents, runs validation commands, and writes a final review summary so your interactive session can merge the results.

Use it from Codex, Gemini CLI, Claude Code, or any local coding agent that can read `SKILL.md` and run shell commands.

## What It Does

- Splits large implementation work across multiple coding agents.
- Runs each worker in its own git worktree.
- Keeps durable requirements, shared architecture, contracts, and file ownership in `coord/DECISIONS.md`.
- Stores compact run context and per-agent task boundaries in `coord/context.json` so the background loop does not need the original chat.
- Supervises liveness, progress, validation, restarts, and worker questions.
- Provides a live terminal dashboard.
- Produces `coord/review-summary.txt` for final human/agent integration.
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
3. draft the topology-aware decomposition and, if configured, run optional read-only plan reviewers;
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
node /path/to/multi-agent-orchestrator/scripts/bootstrap.js \
  --project "Build the requested feature" \
  --coord ./coord

# Optional: run one read-only plan-review iteration before finalizing context.json.
node /path/to/multi-agent-orchestrator/scripts/review-plan.js \
  --iteration 1 \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord

# Launch worker worktrees and the background loop.
node /path/to/multi-agent-orchestrator/scripts/launch-all.js --coord ./coord

# Open the live dashboard.
node /path/to/multi-agent-orchestrator/scripts/dashboard.js --coord ./coord
```

Most users should let the caller agent run these commands after it has read `SKILL.md`.

## How It Works

1. The interactive caller session acts as architect. It chooses the execution topology, decomposes the task, resolves shared foundations, assigns file ownership, records durable decisions, and gives each worker a `read_first` file/path list.
2. `scripts/bootstrap.js` initializes `coord/`, the state directory shared by the caller, workers, and background loop.
3. `scripts/launch-all.js` creates one git worktree per agent, renders prompts from `references/worker-prompt-template.md`, spawns workers, and starts the background loop.
4. `scripts/orchestrator-loop.js` supervises workers. It arbitrates questions, detects hung or stuck workers, restarts within limits, and runs validation commands.
5. When all workers finish, the loop writes `coord/review-summary.txt`.
6. The interactive caller session reviews diffs, runs final checks, merges approved work, and removes completed worktrees.

## Runtime Files

| Path | Purpose |
| --- | --- |
| `coord/context.json` | Compact run context, final execution topology, task map, `read_first` hints, and worker boundaries. |
| `coord/DECISIONS.md` | Human-readable source of truth for durable requirements, architecture, APIs, ownership, and constraints. |
| `coord/agents.json` | Current worker state. |
| `coord/decisions.jsonl` | Arbitration and restart decisions. |
| `coord/plan-reviews/` | Optional Phase 1.5 draft plans, reviewer streams, parsed reviewer JSON, and caller reconciliations. |
| `coord/review-summary.txt` | Final handoff summary after workers complete. |
| `.agents/worktrees/<agent>` | Worker git worktrees for most CLIs. |
| `.kilocode/worktrees/<agent>` | Worker git worktrees for Kilo Code. |

## Configuration

The runtime reads `orchestrator.config.js` from the target project root. If no file exists, it uses built-in defaults.

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

```js
module.exports = {
  default_cli: "kilo",

  // Optional: use a different CLI/model for arbitration.
  // orchestrator_cli: "claude",

  // Optional: read-only plan reviewers run before final task decomposition.
  // reviewers: [
  //   {
  //     name: "architecture",
  //     cli: "claude",
  //     model: "claude-sonnet-4-6",
  //     review_focus: "ownership boundaries, shared foundations, and validation gaps",
  //   },
  // ],
  // max_plan_review_iterations: "auto",

  default_timeout_mins: 10,
  default_progress_timeout_mins: 15,
  default_max_restarts: 3,
};
```

The repository root includes a fuller `orchestrator.config.js` with all built-in CLI templates and comments.

## Supported Worker CLIs

Built-in templates are provided for:

- `kilo`
- `aider`
- `claude`
- `codex`
- `gemini`
- `opencode`

Custom CLIs are supported by adding both `cli_templates.<name>` and `cli_health_checks.<name>` in `orchestrator.config.js`. The runtime does not guess a fallback command shape for custom CLIs.

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
- a final review summary for the integrating agent.

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
