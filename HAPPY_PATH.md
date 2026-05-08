# Happy Path

This is the expected end-to-end flow for using this project as a caller-neutral multi-agent orchestration runtime. The runtime is centered on one interactive caller session plus headless worker CLIs.

## 1. Install or locate the runtime

Clone or symlink this repository wherever your caller can read it. Examples:

```bash
# Codex skill install
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /path/to/multi-agent-orchestrator \
  "${CODEX_HOME:-$HOME/.codex}/skills/multi-agent-orchestrator"

# Gemini CLI extension install
gemini extensions install /path/to/multi-agent-orchestrator

# Claude Code skill install
mkdir -p ~/.claude/skills
ln -s /path/to/multi-agent-orchestrator \
  ~/.claude/skills/multi-agent-orchestrator
```

There is no project install step. The scripts use Node.js built-ins only, so there is no `npm install`, `node_modules`, or build command.

## 2. Prepare worker CLIs

Install and authenticate at least one supported headless coding CLI:

- `kilo`
- `aider`
- `claude`
- `codex`
- `gemini`
- `opencode`

Workers run non-interactively, so the selected CLI must already be signed in, have any required API keys configured, and have a default model selected.

## 3. Configure orchestration defaults

Review `orchestrator.config.js` in the target project root, or rely on the runtime defaults.

Important settings:

- `default_cli`: the worker CLI used for coding tasks and cheap monitor calls.
- `orchestrator_cli`: optional CLI used by the background loop for arbitration. If omitted, it follows `default_cli`.
- `cli_templates`: command templates for each supported or custom CLI.
- `default_timeout_mins`: liveness timeout when logs stop.
- `default_progress_timeout_mins`: progress timeout when logs continue but code does not change.
- `default_max_restarts`: restart cap per agent.

Happy path default: keep `default_cli: "kilo"` and configure Kilo itself to use a fast, cheap model. Set `orchestrator_cli` only when arbitration should use a different CLI/model.

## 4. Run preflight

Before launching agents, verify that the configured CLIs are installed, authenticated, and able to answer a tiny prompt:

```bash
node /path/to/multi-agent-orchestrator/scripts/preflight.js
```

Expected result: preflight prints model/configuration heads-up information, then passes install and auth probes for the worker CLI and orchestrator CLI. Fix any missing binary, auth, API key, or model-selection failure before continuing.

## 5. Ask the caller session to decompose a large task

In a target project, ask the interactive caller session to split a large feature into parallel agents. Depending on caller:

- Codex can invoke the skill as `$multi-agent-orchestrator` when installed as a Codex skill.
- Gemini CLI can invoke `/multi-agent-orchestrator` when installed as a Gemini extension.
- Claude Code can invoke `/multi-agent-orchestrator` when installed as a Claude Code skill.
- Any local coding agent can be told to read `/path/to/multi-agent-orchestrator/SKILL.md`.

The caller session should:

1. Decide whether the request is large enough for multi-agent work.
2. Handle shared foundations first in the main worktree, such as package files, schemas, shared types, routers, or test setup.
3. Commit that foundation so workers start from a stable base.
4. Split the remaining work into non-overlapping agent boundaries.
5. Assign each agent clear allowed paths, forbidden paths, and a validation command.

The key happy-path rule is that workers should not fight over the same shared files. Shared architecture goes first; isolated tasks go parallel afterward.

## 6. Bootstrap coordination state

From the target project root, create the `coord/` state directory:

```bash
node /path/to/multi-agent-orchestrator/scripts/bootstrap.js \
  --project "Build the requested feature" \
  --coord ./coord
```

Then the caller session fills in `coord/context.json` with:

- `project`: one-line project description.
- `chat_context`: user preferences, architecture notes, naming conventions, and gotchas that the background loop will not otherwise know.
- `requirements`: concrete requirements.
- `constraints`: concrete constraints.
- `tasks`: one record per worker agent.

It also writes `coord/DECISIONS.md` as the durable human-readable contract for shared architecture, file ownership, APIs, and data-model decisions.

## 7. Launch all workers

Start the agent worktrees, render prompts, spawn workers, and launch the self-healing background loop:

```bash
node /path/to/multi-agent-orchestrator/scripts/launch-all.js --coord ./coord
```

On success, the launcher:

- creates one git worktree per agent under `.kilocode/worktrees/<agent>` for Kilo or `.agents/worktrees/<agent>` for other CLIs;
- renders each prompt from `references/worker-prompt-template.md`;
- starts each worker through `scripts/spawn-agent.js`;
- records worker state in `coord/agents.json`;
- starts `scripts/orchestrator-loop.js` with `nohup`;
- prints worker PIDs, log paths, and the loop PID.

At this point, the starter session can stop actively managing the run. The background loop owns supervision.

## 8. Monitor progress

Open the dashboard manually when you want a live view:

```bash
node /path/to/multi-agent-orchestrator/scripts/dashboard.js --coord ./coord
```

The dashboard reads the `coord/` state and shows worker status, recent activity, restart counts, and recent orchestrator decisions.

During the run, the loop handles the normal supervision path:

- If an agent asks a question or reports a conflict, the loop arbitrates it with `orchestrator_cli`.
- If logs stop for too long, the loop treats the worker as hung.
- If logs continue but code does not change, the loop asks for a one-sentence AI review and soft-restarts the worker with that correction.
- If a worker says it is done, the loop runs its `validation_command`.
- If validation passes, the agent is marked `completed`.
- If validation fails, the loop soft-restarts the agent with the failure output.

## 9. Wait for review summary

When all agents complete, the loop collects worktree diffs and writes:

```text
coord/review-summary.txt
```

This summary is the handoff point back to the interactive caller session.

## 10. Review and integrate

Ask the interactive caller session:

```text
The agents are done. Please review and integrate their work.
```

The integrator session should:

1. Read `coord/review-summary.txt`.
2. Inspect `coord/agents.json` for completed worktrees.
3. Review each agent diff with `git diff main...<agent-name>` or the configured base branch.
4. Run relevant validation in each worktree or after staging integration.
5. Merge approved branches into the main worktree.
6. Remove completed worktrees after successful merge.

Typical merge commands:

```bash
git merge <agent-name>
git worktree remove <worktree-path>/<agent-name>
```

## 11. Verify the final project

Run the target project's normal checks after integration, such as tests, lint, type checks, or application smoke tests.

For this runtime repository itself, the happy-path verification command is:

```bash
node scripts/run-tests.js
```

Tests are dependency-free and use fake CLIs against temporary git repositories, so they do not require real worker credentials.

## Successful outcome

The happy path is complete when:

- each worker task is either merged or deliberately rejected;
- completed worktrees are cleaned up;
- `coord/review-summary.txt` has been reviewed;
- final project validation passes;
- durable architectural decisions are reflected in `coord/DECISIONS.md` when they should survive beyond the run.
