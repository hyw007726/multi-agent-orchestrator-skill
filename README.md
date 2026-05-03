# Multi-Agent Orchestrator (Claude Skill)

A production-ready, CLI-agnostic skill that turns your Claude Code session into a high-level orchestrator managing multiple headless worker agents in parallel. 

It safely sandboxes workers into `git worktrees`, manages their lifecycles via a self-healing background daemon, and natively supports Kilo Code, Aider, Claude Code, Gemini CLI, and OpenCode.

## 🚀 Features
- **Parallel Worktrees**: Agents work simultaneously in physically isolated `.kilocode/worktrees/` directories.
- **Universal Dashboard**: A beautiful TUI dashboard that live-tails the logs of all your background agents.
- **CLI Agnostic**: Natively supports Kilo Code (`--auto`), Aider (`--yes`), Claude (`-p`), and more.
- **Self-Healing Loop**: The Orchestrator loop detects crashed agents via OS-level PID pinging and gracefully aborts.
- **Proactive Schema Enforcement**: Claude actively prevents data-model conflicts by defining API contracts *before* spawning agents.

## 📦 Prerequisites

1. **Claude Code CLI**: Installed and authenticated (this acts as the orchestrator loop).
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
2. **TypeScript & TS-Node**: For running the daemon scripts.
   ```bash
   npm install
   ```
3. **A Worker CLI**: You must have at least one headless worker CLI installed globally and authenticated (e.g., Kilo Code, Aider).
   ```bash
   npm install -g kilo-cli
   ```

## 🛠️ Installation & Usage

1. **Import the Skill**: In your Claude Desktop app or Claude Code CLI, add this folder as a Custom Skill.
2. **Start a Project**: Ask Claude to build a complex project using the Multi-Agent Orchestrator.
3. **Sit Back**: Claude will read `SKILL.md`, decompose the task, spawn the background workers, and launch the Live Dashboard. 

## 🔄 Supported CLIs
You can instruct Claude to use different CLIs by appending the `--cli` flag:
- `--cli kilo` (Default)
- `--cli aider`
- `--cli claude`
- `--cli codex`
- `--cli gemini`
- `--cli opencode`

*(You can also pass custom arguments to your chosen CLI by appending them after `--`, e.g., `--cli aider -- --model gpt-4o`)*

## ⚠️ Important Note
Make sure your chosen worker CLI is fully authenticated and has a default model selected. Because the workers run as non-interactive background processes, they will hang indefinitely if they encounter an interactive login prompt!
