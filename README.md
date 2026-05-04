# Multi-Agent Orchestrator (Claude Skill)

A production-ready, CLI-agnostic skill that turns your Claude Code session into a high-level orchestrator managing multiple headless worker agents in parallel. 

It safely sandboxes workers into `git worktrees`, manages their lifecycles via a self-healing background daemon, and natively supports Kilo Code, Aider, Claude Code, Gemini CLI, and OpenCode.

## 🚀 Features
- **Turn One Agent Into Many**: Break a complex task into parallel workstreams — Claude decomposes the work, spawns independent agents, and merges the results.
- **CLI Agnostic**: Use any headless coding agent as a worker — Kilo Code, Aider, Claude Code, Gemini CLI, OpenCode, or Codex. Mix and match freely.
- **Live Dashboard**: A real-time TUI that streams every agent's logs so you can watch the work unfold from a single terminal window.
- **Built for Efficiency**: Pair a high-reasoning orchestrator (e.g. Claude Opus) with cheaper, faster, instruction-faithful worker models — strong architectural decisions at a fraction of the cost.
- **Intelligent Auto-Review**: Once agents complete, the orchestrator automatically generates an AI-powered summary and pops open a new terminal window for an at-a-glance project review.

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

All workers are automatically launched with their respective "bypass permissions" flags so they execute autonomously without prompting for human approval.
