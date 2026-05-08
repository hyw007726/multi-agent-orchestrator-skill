---
name: multi-agent-orchestrator
description: Decompose a large coding task into parallel worker agents running in isolated git worktrees with self-healing supervision. Use when the user asks Gemini CLI to build something complex with multiple agents, split work in parallel, spawn a worker swarm, or coordinate background headless CLI workers.
---

# Multi-Agent Orchestrator

Use the repository root `SKILL.md` as the source of truth:

`../../SKILL.md`

Resolve the extension/repository root before running scripts, then run `scripts/preflight.js`, `scripts/bootstrap.js`, `scripts/launch-all.js`, and `scripts/dashboard.js` from the target project as described there.
