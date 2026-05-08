# Multi-Agent Orchestrator Caller Context

This repository is an Agent Skill and local runtime for coordinating parallel coding agents.

When the user asks to split a large implementation into parallel workers, use `SKILL.md` as the source of truth. Resolve this repository's absolute path, run its Node scripts from the target project, and keep `coord/context.json` plus `coord/DECISIONS.md` explicit because the background loop cannot see the original chat.

Caller-neutral runtime defaults:
- `default_cli` selects the worker CLI.
- If `orchestrator_cli` is omitted, arbitration uses `default_cli`.
- Set `orchestrator_cli` explicitly only when the user wants a different arbitration model or CLI.
- Every CLI used by the runtime must have a `cli_templates.<name>` entry; do not assume Claude-style `-p` flags for custom CLIs.
