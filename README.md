# Multi-Agent Orchestrator

A caller-neutral orchestrator runtime that turns an interactive coding-agent session into a high-level coordinator managing multiple headless worker agents in parallel.

It safely sandboxes workers into `git worktrees`, manages their lifecycles via a self-healing background daemon, and natively supports Kilo Code, Aider, Claude Code, Codex, Gemini CLI, and OpenCode.

## Features

- **Turn One Agent Into Many**: Break a complex task into parallel workstreams. The caller agent decomposes the work, spawns independent agents, and later integrates the results.
- **Caller Neutral**: Use it from Codex, Gemini CLI, Claude Code, or any other local coding agent that can read `SKILL.md` and run shell commands.
- **Worker CLI Agnostic**: Use any configured headless coding agent as a worker. Mix Kilo Code, Aider, Claude Code, Gemini CLI, OpenCode, Codex, or custom CLIs via `cli_templates`.
- **Neutral Arbitration Defaults**: If `orchestrator_cli` is omitted, the background loop uses `default_cli`; no Claude installation is required unless you explicitly choose Claude.
- **Self-Healing Loop**: Detects hung agents and stuck agents, then restarts or course-corrects them within a per-agent restart cap.
- **Validation Loop**: Each agent can have a `validation_command`; failed validation triggers a soft restart with the failure log.
- **Shared Architectural Source of Truth**: `coord/DECISIONS.md` stores durable contracts for APIs, data models, and file ownership. Runtime approvals are preserved in `coord/decisions.jsonl`.
- **Live Dashboard**: A real-time TUI streams worker status, restart counts, and recent orchestrator decisions.
- **Auto-Review**: When agents finish, the loop writes an AI-generated summary to `coord/review-summary.txt`.

## Configuration

The runtime reads `orchestrator.config.js` from the target project root.

Key settings:

- `default_cli` - worker CLI for coding tasks and cheap monitor calls.
- `orchestrator_cli` - optional CLI for request arbitration. If omitted, it follows `default_cli`.
- `cli_templates` - structured argv templates or explicit shell-string templates for every CLI the runtime may invoke.
- `default_timeout_mins` / `default_progress_timeout_mins` - liveness and progress thresholds.
- `default_max_restarts` - restart cap per agent.
- `orchestrator_failure_threshold` - consecutive arbitration-CLI failures before the dashboard shows a stalled banner.
- `launch_dashboard` / `launch_review_terminal` - GUI terminal spawning controls. Dashboard defaults to `auto`: open on local macOS, stay manual elsewhere.

Recommended default: keep `default_cli: "kilo"` and configure Kilo itself to use a fast, cheap model. Set `orchestrator_cli` only when you want arbitration to use a different CLI/model.

## Prerequisites

- Node.js.
- Git with worktree support.
- At least one headless worker CLI installed, authenticated, and configured with a default model.

The runtime has no package dependencies. Every script uses Node.js built-ins, so there is no `npm install`, no `node_modules`, and no build step.

Workers run non-interactively. Any selected CLI must already be signed in and able to answer a tiny prompt without setup prompts.

## Install For Callers

Clone the repository anywhere if you only want manual use:

```bash
git clone https://github.com/hyw007726/claud-multi-agent-orchestrator-skill.git \
  ~/src/multi-agent-orchestrator
```

Then ask your coding agent to read `~/src/multi-agent-orchestrator/SKILL.md` and use that workflow from the target project.

### Codex

Install or symlink this folder into your Codex skills directory:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /path/to/multi-agent-orchestrator \
  "${CODEX_HOME:-$HOME/.codex}/skills/multi-agent-orchestrator"
```

This repository also includes `agents/openai.yaml` for Codex UI metadata and `AGENTS.md` as a lightweight repository-level caller guide.

### Gemini CLI

This repository is installable as a Gemini CLI extension:

```bash
gemini extensions install /path/to/multi-agent-orchestrator
```

The extension manifest loads `GEMINI.md`, which imports `SKILL.md`, exposes a native skill wrapper under `skills/multi-agent-orchestrator/`, and provides a `/multi-agent-orchestrator` command from `commands/multi-agent-orchestrator.toml`.

### Claude Code

Claude Code can still use the same `SKILL.md` package:

```bash
mkdir -p ~/.claude/skills
ln -s /path/to/multi-agent-orchestrator \
  ~/.claude/skills/multi-agent-orchestrator
```

## Use

1. Configure `orchestrator.config.js` in the target project if the defaults are not right.
2. Run preflight from the target project:

   ```bash
   node /path/to/multi-agent-orchestrator/scripts/preflight.js
   ```

3. Ask the interactive caller session to decompose a large task using the multi-agent orchestrator workflow.
4. The caller bootstraps `coord/`, fills `coord/context.json`, writes `coord/DECISIONS.md`, and launches:

   ```bash
   node /path/to/multi-agent-orchestrator/scripts/launch-all.js --coord ./coord
   ```

5. Monitor with the auto-opened dashboard on local macOS, or run it manually with:

   ```bash
   node /path/to/multi-agent-orchestrator/scripts/dashboard.js --coord ./coord
   ```

6. When the loop finishes, ask the caller session to review `coord/review-summary.txt`, inspect each worktree diff, and merge approved branches.

## Supported Worker CLIs

Built-in templates are provided for:

- `kilo`
- `aider`
- `claude`
- `codex`
- `gemini`
- `opencode`

Custom CLIs are supported by adding both `cli_templates.<name>` and `cli_health_checks.<name>` in `orchestrator.config.js`. The runtime no longer guesses a fallback command shape for custom CLIs.

## Testing

```bash
node scripts/run-tests.js
```

Tests are dependency-free and use fake CLIs against temporary git repositories, so they do not require real Kilo, Aider, Claude, Codex, Gemini, or OpenCode credentials.
