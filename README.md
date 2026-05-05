# Multi-Agent Orchestrator (Claude Skill)

A production-ready, CLI-agnostic skill that turns your Claude Code session into a high-level orchestrator managing multiple headless worker agents in parallel.

It safely sandboxes workers into `git worktrees`, manages their lifecycles via a self-healing background daemon, and natively supports Kilo Code, Aider, Claude Code, Gemini CLI, and OpenCode.

## 🚀 Features
- **Turn One Agent Into Many**: Break a complex task into parallel workstreams — Claude decomposes the work, spawns independent agents, and merges the results.
- **CLI Agnostic**: Use any headless coding agent as a worker — Kilo Code, Aider, Claude Code, Gemini CLI, OpenCode, or Codex. Mix and match freely.
- **Two-Tier Cost Control**: A configurable `orchestrator_cli` arbitrates cross-cutting decisions (point it at a strong reasoning model), while the worker CLI handles bulk coding and the cheap monitor calls — strong architecture at a fraction of the cost.
- **Self-Healing Loop**: Detects hung agents (no log output) and stuck agents (log output but no code progress). When an agent stalls, a single-shot LLM call diagnoses what's wrong and respawns with a 1-sentence course-correction.
- **Validation Loop**: Each agent is assigned a `validation_command`. When the agent signals "done" the loop runs validation; on failure it auto-`soft_restart`s with the error log so the agent can fix its own code.
- **Shared Architectural Source of Truth**: A `coord/DECISIONS.md` file captures shared API contracts, data models, and structural rules. Worker agents are instructed to read it before coding so foundational decisions never drift across worktrees.
- **Live Dashboard**: A real-time TUI streams every agent's activity, restart count, and recent orchestrator decisions from a single terminal window.
- **Auto-Review**: When agents finish, the loop generates an AI-powered summary and pops it open in a new terminal window.

## Reliability
- **Restart cap** — every restart (validation failure, AI-Review course-correction, explicit action) bumps a per-agent `restart_count`. Past `default_max_restarts` (default 3) the loop stops respawning so failures can't thrash forever.
- **PID safety** — before sending any signal the loop verifies the stored PID's cmdline via `ps`, so a recycled PID can't be SIGTERM'd by accident.
- **Recovery tags** — `hard_restart` captures uncommitted+untracked work as a `recovery/<agent>/<timestamp>` git tag *before* resetting, so wiped state is always recoverable with `git show <tag>`.
- **Soft abort** — closing the dashboard window leaves agents running. Ctrl+C asks for confirmation; the resulting abort kills processes but preserves worktree contents (no `git reset --hard`).
- **Stalled-CLI surfacing** — if the arbitration CLI fails repeatedly the dashboard renders a banner with diagnostics, so you know whether the loop is making progress or stuck.
- **Argv-form validation** — `validation_command` accepts a JSON argv array (`["npm","run","test"]`) so it runs with `shell:false` — no shell expansion, no injection surface. Shell-string form still works for pipes / `&&`.

## ⚙️ Configuration (`orchestrator.config.yml`)
The skill reads `orchestrator.config.yml` at the project root. Key knobs:
- `default_cli` — worker CLI for spawning agents and the cheap monitor calls.
- `orchestrator_cli` — CLI used by the loop for request arbitration (defaults to `claude`).
- `cli_templates` — exact bash invocations for each supported CLI; insulates the system from third-party flag changes.
- `default_timeout_mins` / `default_progress_timeout_mins` — liveness and progress thresholds.
- `default_max_restarts` — restart cap per agent.
- `claude_failure_threshold` — consecutive arbitration-CLI failures before the dashboard shows the stalled banner.

If the file is absent, the orchestrator picks sensible defaults based on project size.

**Recommended default combination:** `default_cli: kilo` + DeepSeek V4 Pro (`deepseek-v4-pro`, 1M context, cheap and fast) for workers, with `orchestrator_cli: claude` (a stronger reasoning model) for arbitration. Kilo's model selection lives in its own BYOK provider settings, so no template change is needed — just pick `deepseek-v4-pro` in Kilo's model picker after you authenticate, and run `npx ts-node scripts/preflight.ts --auth` to confirm the chain is exercising the API end-to-end (a bare `--version` check only proves the binary is installed).

## 📦 Prerequisites

1. **Claude Code CLI** (acts as the orchestrator session and as the default arbitration CLI):
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
2. **A Worker CLI**: at least one headless worker CLI installed and authenticated (e.g. Kilo Code, Aider, Codex, Gemini, OpenCode, or a second `claude` invocation).
   ```bash
   npm install -g kilo-cli
   ```

> **Note:** This is a **Claude Code skill**, not a Claude.ai (web) or Claude Desktop one. The orchestrator shells out to `nohup`, `git worktree`, `kill`, and `osascript`/terminal-spawning commands, none of which run inside the web/desktop sandbox. Install it under Claude Code as described below.

## 🛠️ Installation

One command — Claude Code auto-discovers any folder under `~/.claude/skills/` that contains a `SKILL.md`, and the skill self-installs its Node deps the first time you invoke it (no manual `npm install`).

```bash
git clone https://github.com/hyw007726/claud-multi-agent-orchestrator-skill.git \
  ~/.claude/skills/multi-agent-orchestrator
```

That's it. Open Claude Code in any project and ask it to "split this large feature into parallel agents" — on first run, Claude will detect that `node_modules/` is missing in the skill folder, run `npm install` once (~5s), and proceed. Subsequent invocations skip the install. You can also invoke the skill explicitly with `/multi-agent-orchestrator`.

**Updating:** `git pull` inside `~/.claude/skills/multi-agent-orchestrator`. Claude Code live-reloads skills with no restart; if a future update changes deps, the next invocation re-runs `npm install` automatically.

**Uninstalling:** `rm -rf ~/.claude/skills/multi-agent-orchestrator`.

**Project-only install** (e.g. shared via a team repo so only that project sees the skill): clone into `<your-project>/.claude/skills/multi-agent-orchestrator` instead of the user-level path. Self-install behavior is the same.

**Developer install** (you want to hack on the skill itself and have changes show up live): clone wherever you keep your code, then symlink it into the skills directory.
```bash
git clone https://github.com/hyw007726/claud-multi-agent-orchestrator-skill.git ~/src/multi-agent-orchestrator
mkdir -p ~/.claude/skills
ln -s ~/src/multi-agent-orchestrator ~/.claude/skills/multi-agent-orchestrator
```

## 🚀 Using the Skill

1. **(Optional) Configure**: Edit `orchestrator.config.yml` to set your preferred CLIs, timeouts, and restart caps. The shipped defaults work out of the box.
2. **Verify the worker chain end-to-end** (catches missing API keys / unselected models in 5–10s instead of a 10-minute liveness timeout):
   ```bash
   npx ts-node ~/.claude/skills/multi-agent-orchestrator/scripts/preflight.ts --auth
   ```
3. **Start a project**: Ask Claude to build a complex project that genuinely benefits from parallelism. Claude reads `SKILL.md`, decomposes the task, writes `coord/DECISIONS.md`, spawns the workers, and launches the Live Dashboard.
4. **Sit back**: when all agents finish, the loop opens a review-summary terminal window. Hand control back to Claude in a new (or the same) session and say *"The agents are done. Please review and integrate their work."*

## 🔄 Supported CLIs
You can instruct Claude to use different CLIs by appending the `--cli` flag:
- `--cli kilo` (Default)
- `--cli aider`
- `--cli claude`
- `--cli codex`
- `--cli gemini`
- `--cli opencode`

*(You can also pass custom arguments to your chosen CLI by appending them after `--`, e.g., `--cli aider -- --model gpt-4o`)*

The same set is supported for the orchestrator CLI itself via `orchestrator_cli` in `orchestrator.config.yml` — point it at a high-tier model for arbitration, or at a fast worker if you want monitoring to stay cheap.

## ⚠️ Important Note
Make sure your chosen worker CLI is fully authenticated and has a default model selected. Because the workers run as non-interactive background processes, they will hang indefinitely if they encounter an interactive login prompt!

All workers are automatically launched with their respective "bypass permissions" flags so they execute autonomously without prompting for human approval.
