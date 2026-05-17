# Contributing

Thanks for helping improve Multi-Agent Orchestrator. This project is a local runtime for coordinating headless coding-agent CLIs, so contributions should keep the workflow inspectable, deterministic where possible, and safe to run on real repositories.

## Good First Contributions

- Improve install and setup docs for a specific caller or CLI.
- Add a small reproducible example under `examples/`.
- Tighten error messages from the Node scripts.
- Add tests for an existing edge case.
- Improve dashboard readability without changing the runtime protocol.

## Development Setup

Requirements:

- Node.js
- Git with worktree support
- Optional authenticated worker CLIs for live tests: Kilo, Claude Code, Codex, Gemini CLI, or OpenCode

The default test suite has no package install step:

```bash
node scripts/run-tests.js
```

Live model tests are opt-in because they call authenticated provider CLIs and may use paid model calls:

```bash
RUN_LIVE_MODEL_TESTS=1 node scripts/run-live-tests.js --provider codex
```

## Pull Request Guidelines

- Keep changes scoped to one behavior or documentation improvement.
- Prefer JSON-argv command forms over shell strings when adding runtime commands.
- Add or update tests for runtime behavior changes.
- Do not commit local coordination artifacts such as `coord/`, worker worktrees, logs, or provider credentials.
- Include the validation command you ran in the PR description.

## Design Principles

- The interactive caller owns architecture and final integration.
- Workers should receive explicit file boundaries and focused `read_first` context.
- The background loop should be able to recover, log, and explain what happened without relying on hidden chat history.
- The runtime should remain usable without npm dependencies unless a dependency clearly pays for its cost.

## Reporting Issues

When filing an issue, include:

- operating system and shell;
- Node.js version;
- selected worker CLI and version;
- the command you ran;
- relevant `coord/` logs with secrets removed;
- what you expected and what happened instead.
