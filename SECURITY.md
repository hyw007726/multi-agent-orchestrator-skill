# Security Policy

## Supported Versions

Security fixes are handled on the `main` branch. If versioned releases are added later, this policy will be updated with supported release lines.

## Reporting a Vulnerability

Please do not open a public issue for a sensitive vulnerability.

Preferred reporting path:

1. Use GitHub's private vulnerability reporting for this repository if it is enabled.
2. If private reporting is not available, contact the maintainer through the GitHub profile for `hyw007726`.

Include enough detail to reproduce the issue, such as the affected command, operating system, selected worker CLI, relevant configuration, and sanitized logs. Do not include API keys, tokens, private repository contents, or provider credentials.

## Security Scope

This project launches local coding-agent CLIs in autonomous mode and creates git worktrees for worker isolation. Security-sensitive areas include:

- command template rendering and argument handling;
- process spawning, termination, and restart behavior;
- path handling around `coord/` and worktree directories;
- log and event file handling;
- prompts or files that might expose secrets to worker CLIs.

The runtime does not sandbox the selected worker CLI beyond git worktree isolation. Review `orchestrator.config.jsonc` and any local overrides before running the orchestrator on sensitive repositories.
