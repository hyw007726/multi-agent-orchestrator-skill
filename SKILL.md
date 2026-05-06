---
name: multi-agent-orchestrator
description: Decompose a large coding task into parallel worker agents (Kilo, Aider, Claude, Codex, Gemini, OpenCode) running in isolated git worktrees with self-healing supervision. Use when the user asks to "build something complex with multiple agents", "split this work in parallel", "spawn a swarm", or to coordinate background headless CLI workers.
---

# FULL Claude Orchestrator Skill

This skill defines a COMPLETE, CLI-agnostic multi-agent orchestration system.

## Prerequisites & Recommendations
Before using this skill, ensure you have:
1. **A Headless Worker CLI**: Installed globally. This skill uses `kilo` (Kilo Code) by default, but it can orchestrate **Aider**, **Claude Code**, **Gemini**, **Codex**, **OpenCode**, or any other CLI added to `cli_templates` in `orchestrator.config.js`. **Important:** The CLI must be fully configured ahead of time (e.g., signed in, API keys set, model selected, codebase context loaded, etc.). Because the agents run headlessly in the background **non-interactively**, they will crash or hang if they encounter interactive setup prompts.


> **Architectural Recommendation & Intelligence Boundaries:**
> This skill is highly optimized for cost-efficiency without sacrificing quality. It relies on **three distinct decision-making contexts**, each driven by a configurable CLI in `orchestrator.config.js`:
>
> 1. **Initial Decomposition (Interactive Session):** Your active Orchestrator session (e.g., Claude Code with a high-tier reasoning model like Opus 4.7) acts as the primary architect. It analyzes the task, breaks it into non-overlapping boundaries, writes the `coord/context.json`, and spawns the background agents.
> 2. **The Background Orchestrator Loop (Headless Script):** Once launched, the background loop has **no access to your chat history**. It splits its LLM work across two CLIs:
>     - **Request arbitration** (cross-cutting decisions over pending requests, plus `end_agent` / `soft_restart` / `hard_restart` actions) is invoked through the **`orchestrator_cli`** (defaults to `claude`). Arbitration benefits from a stronger reasoning model since it weighs conflicts and architectural trade-offs.
>     - **Triggered AI-Review** (the 1-sentence course-correction sent when an agent stalls) and the **final review summary** in Phase 6 are invoked through the **Worker CLI** (`default_cli`). These are narrow, single-turn calls that stay cheap.
> 3. **Final Integration (Interactive Session):** After the background loop completes, you return to a high-tier Orchestrator session to act as the integrator, reviewing the completed worktrees and safely merging them.
>
> **Model Selection Strategy:** Use a powerful reasoning model for your interactive Orchestrator sessions (Contexts 1 & 3) and for the `orchestrator_cli` so request arbitration stays sound. Configure your **Worker CLI** (`default_cli`) to use cost-efficient fast models for the bulk coding and the cheap monitor calls. If you want monitoring to be even cheaper, point `orchestrator_cli` at a fast worker too — the system will respect whichever CLI you configure.
>
> **How to pin a model:** Two patterns depending on the CLI.
> - **Inline-flag CLIs** (claude, aider, gemini): model selection is part of `cli_templates`. The template string is what gets executed verbatim, so add the CLI's model flag inline — e.g. `claude -p ... --dangerously-skip-permissions --model claude-sonnet-4-6` for Sonnet, or `aider ... --model gpt-4o-mini`.
> - **External-config CLIs** (kilo, opencode, codex): model selection lives in the CLI's own settings (BYOK provider + model picker), not the template. The template stays simple; the model is whatever the user has configured in that CLI.
>
> **`claude` is the one CLI where pinning is effectively required, not optional.** The other inline-flag CLIs (aider, gemini) read their model from independent config (env vars, model files), so a worker spawn picks up the user's existing setup. `claude` is different — without `--model`, the spawned worker silently inherits the model of the parent Claude Code session running this skill (typically Opus 4.7 if you launched from an Opus orchestrator session), routing bulk worker coding to the orchestrator's expensive reasoning model. The shipped `cli_templates.claude` already pins Sonnet 4.6 for this reason.
>
> There is intentionally no separate `default_model` config key, because each CLI uses different flag names and model-id namespaces (and some don't take a flag at all), so keeping it close to the actual mechanism avoids a leaky aliasing layer.
>
> **Recommended default combination:** `default_cli: kilo` + DeepSeek V4 Pro (`deepseek-v4-pro`, 1M context, cheap and fast). Because Kilo is an external-config CLI, set this up by configuring DeepSeek as a BYOK provider in Kilo and selecting `deepseek-v4-pro` in its model picker — `cli_templates.kilo` does not need to change. Then run `node <skill>/scripts/preflight.js` to confirm the chain (API key + provider + model selection) is actually exercising the API, not just confirming the binary is installed.

## ⚙️ Configuration (`orchestrator.config.js`)
Before beginning Phase 1, you MUST check if an `orchestrator.config.js` file exists in the project root. This file acts as the dynamic source of truth for the user's preferences.

If it exists, read it to determine:
- **`default_cli`**: The Worker CLI to use for spawning agents and for the cheap AI-Review / final-summary calls.
- **`orchestrator_cli`**: The CLI used by the background loop for request arbitration (defaults to `claude`). Set this independently from `default_cli` if you want arbitration to use a stronger reasoning model than your workers.
- **`cli_templates`**: The exact bash commands used to spawn the worker CLIs. The same templates are reused for `orchestrator_cli` calls and the AI-Review calls, so the system is immune to third-party tool interface changes. **This is also where you pin a model** — append the CLI's model flag (`--model <id>`, `--llm <id>`, etc.) to the template string and that model is used for every spawn driven by it.
- **`default_timeout_mins`**: The default time before an agent is considered hanging (Liveness).
- **`default_progress_timeout_mins`**: The default time before an active agent with zero code changes is considered stuck (Progress).
- **`default_max_restarts`**: The maximum number of times the loop will respawn the same agent before marking it `errored` (defaults to 3). Counted across both validation-failure restarts and AI-Review restarts.
- **`claude_failure_threshold`**: Consecutive arbitration-CLI failures before the loop writes `coord/orchestrator-stalled.flag` (which the dashboard surfaces). Defaults to 5.
- **`poll_min_ms` / `poll_max_ms`**: Adaptive polling bounds for the orchestrator loop. The loop polls at `poll_min_ms` (default 1000) right after seeing pending requests, then exponentially backs off (×1.5 per idle cycle) up to `poll_max_ms` (default 15000). Pass `--poll-interval <ms>` to the loop to disable the heuristic and force a fixed cadence.
- **`cli_health_checks`**: Per-CLI probe commands run by `scripts/preflight.js` to fail fast on install / auth issues. Defaults to `<cli> --version` for every supported CLI.
- **`launch_dashboard` / `launch_review_terminal`**: Optional GUI terminal auto-launch. Disabled by default for MVP reliability in headless/sandboxed terminals; run the dashboard manually or set these to `true` if your terminal environment supports spawning new windows.

Example `orchestrator.config.js`:
```js
// Toggle options by commenting/uncommenting lines.
module.exports = {
  // The background CLI worker to execute tasks
  default_cli: "kilo",

  // Command templates for supported CLIs.
  // Use {prompt_file} as a placeholder for the generated prompt text file.
  cli_templates: {
    kilo: 'kilo run "$(cat {prompt_file})" --auto',
    aider: "aider --message-file {prompt_file} --yes",
    claude: 'claude -p "$(cat {prompt_file})" --dangerously-skip-permissions --model claude-sonnet-4-6',
    gemini: 'gemini --prompt "$(cat {prompt_file})" --yolo',
    codex: 'codex --exec "$(cat {prompt_file})"',
    opencode: 'opencode run "$(cat {prompt_file})" --yes',
  },
};
```

If the file does not exist, you MUST dynamically evaluate the overall size and complexity of the user's project to determine sensible default bounds (e.g., a simple script might only need a 5-minute progress timeout and 3 iterations, while a complex React app might need a 20-minute progress timeout and 10 iterations). You can also offer to create this config file for the user so they can explicitly customize their workflow bounds in the future!

> **Note:** All worker CLIs are automatically launched with their respective "bypass permissions" flags (`--yes`, `--dangerously-skip-permissions`, `--yolo`, `--auto`) so they run fully autonomously in the background. The Orchestrator Loop will remember which CLI tool you spawned the agent with and will automatically use the exact same tool if it needs to respawn the agent after a rollback!

## Phase 0 — Setup

These three steps run unconditionally on every invocation, before any task reasoning begins.

**Step 1 — No setup required:** The skill has no external dependencies — all scripts use Node.js built-in modules only. No `npm install`, no global packages, no build step. Proceed directly to Step 2.

**Step 2 — Read configuration:** Read `orchestrator.config.js` from the project root (as described in the Configuration section above) to load the user's preferred CLI and default bounds.

**Step 3 — Preflight CLI health check (REQUIRED):** Verify the worker CLI and orchestrator CLI are runnable before any decomposition or spawning — an unauthenticated CLI will hang on an interactive prompt for the full liveness timeout otherwise.

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/preflight.js
```

The script checks `default_cli` and `orchestrator_cli` by default. It runs two probes per CLI: a `--version` install check, then an auth probe that exercises the spawn template with a tiny prompt to verify API keys, BYOK provider configuration, and model selection. Pass `--skip-auth` for install-only checks (CI / offline). If any check fails, abort and surface the diagnostic — typical fixes are installing the CLI, putting it on `$PATH`, signing in, or selecting a default model.

## Phase 1 — Task Evaluation & Decomposition

Evaluate whether the user's overall task is suitable for multi-agent orchestration.
- **Do not use this skill** if the task is small, trivial, or requires tightly coupled sequential steps. Advise the user to let you handle it normally.
- **Handle Overlapping Foundations First (CRITICAL):** True non-overlapping boundaries are rare. If agents will need to touch shared files (e.g., `package.json`, generic `types.ts`, test config, database schemas, router setups), **you must handle these sequentially before spawning agents.** If you spawn parallel worktrees that modify the same foundational files, you will create impossible merge conflicts.
  - *Action:* Tell the user: "I need to set up the shared foundation (schemas, package.json, etc.) first to prevent merge conflicts."
  - *Action:* Implement these shared foundations yourself in the current session.
  - *Action:* Commit the foundation.
  - *Action:* Only then, split the remaining work into truly parallel, isolated agent tasks.
- **Proceed** if the task is large, complex, and the foundation is either already set or has just been completed by you.

If proceeding:
1. Break the work down into non-overlapping agent boundaries.
2. Explicitly map out what files each agent is allowed to touch.
3. Determine a `validation_command` for each agent. **Prefer JSON-argv form** so the loop can run it with no shell expansion (e.g. `--validate '["npm","run","test","--","src/foo"]'`); fall back to a shell string only when you need pipes / `&&` / env expansion (e.g. `--validate "npm run lint && npm test"`). Use `null` if no automated validation is possible/needed.
4. Prepare a mapping of agent names to their task descriptions.

## Phase 2 — Bootstrap
When starting a new orchestrated project, create the `coord/` directory at the project root and initialize these files.

**Important Path Resolution:** The scripts required for this workflow are located in the `scripts/` directory next to this `SKILL.md` file. Before running the commands below, determine the absolute path to this skill folder (e.g., if you are reading this from `~/Desktop/multi-agent-orchestrator/SKILL.md`, the path is `~/Desktop/multi-agent-orchestrator`).

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/bootstrap.js \
  --project "Your project description" \
  --coord ./coord
```

### `coord/context.json`
Because the orchestrator loop runs after your Claude CLI session is done, it has **zero access** to your original chat history. **You must heavily compress all user preferences, architectural nuances, and conversational context into a structured `chat_context` object.**

You should also include the tasks you generated in Phase 1 under the `"tasks"` key.

`bootstrap.js` only scaffolds an empty skeleton (`chat_context: {}`, `tasks: {}`). After running it, use the `Edit` tool to fill `context.json` with the structured shape below before you spawn any workers.

```json
{
  "project": "<one-line description of the user's task>",
  "chat_context": {
    "preferences": ["<e.g., Use explicit typing>", "<e.g., Prefer functional components>"],
    "architecture": ["<e.g., MVVM pattern>", "<e.g., Redux for state>"],
    "naming_conventions": ["<e.g., camelCase for variables>", "<e.g., PascalCase for interfaces>"],
    "gotchas": ["<e.g., User is using an older version of Node>"]
  },
  "requirements": ["<requirement 1>", "<requirement 2>"],
  "constraints": ["<constraint 1>", "<constraint 2>"],
  "created_at": "<ISO 8601 timestamp>",
  "tasks": {
    "agent-name": {
      "description": "description of the boundary",
      "timeout_mins": 10,
      "progress_timeout_mins": 15
    }
  }
}
```

### `coord/DECISIONS.md`
To ensure critical architectural rules are never lost in JSON compression, write a human-readable `coord/DECISIONS.md` file. This file acts as the ultimate source of truth for shared API contracts, data models, and structural decisions made in Phase 1. The worker agents are instructed to read this file before they begin coding.

## Phase 3 — Prompt Generation
Use the `references/worker-prompt-template.md` to generate prompts for each agent.

## Phase 4 — Spawning Agents
For each agent:
1. Create a git worktree. If you are using Kilo Code, create it in `.kilocode/worktrees/` so it appears in the VS Code UI. If using Aider or another tool, use `.agents/worktrees/`:
   ```bash
   git worktree add <worktree-path>/<agent-name> -b <agent-name>
   ```
2. **Launch the agent in the background** using the `spawn-agent.js` helper:
   ```bash
   echo "YOUR PROMPT HERE" > /tmp/prompt-<agent-name>.txt
   node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/spawn-agent.js \
     --agent <agent-name> \
     --mode <mode> \
     --prompt-file /tmp/prompt-<agent-name>.txt \
     --coord ./coord \
     --validate '<validation_command>' \   # JSON argv (e.g. '["npm","test"]') is preferred over a shell string
     --timeout <timeout_mins> \
     --progress-timeout <progress_timeout_mins> \
     --cli <cli-name> # Optional: e.g. aider, claude. Defaults to `default_cli` from orchestrator.config.js (kilo if unset).
   ```

> **💡 Tip for Kilo Code Users:** Because the agents are physically spawned inside the `.kilocode/worktrees/` directory path by default, they will automatically appear in your **Kilo Code Agent Manager UI** inside VS Code! You can monitor the specific files they are editing in real-time natively in your IDE.

## Phase 5 — The Orchestrator Loop

To ensure the loop runs independently, launch it in the background and exit:

```bash
nohup node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/orchestrator-loop.js --coord ./coord > coord/orchestrator-loop.out 2>&1 &
```

**Once the loop is started, your job as the starter session is done. You should politely inform the user that the orchestration loop is running in the background and exit.**

By default the dashboard is not auto-launched. To monitor progress manually, run:
```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/dashboard.js --coord ./coord
```

### Progress Monitoring
The orchestrator loop doesn't just watch for crashes; it monitors for **actual code progress**. 
- **The "Killer" Timeout (Liveness Detection)**: If an agent stops emitting logs for the configured `timeout_mins` duration, it is assumed hanging, killed, and marked as errored.
- **The "Reviewer" Timeout (Progress Detection)**: If an agent is active (emitting logs) but fails to accumulate any git commits or unstaged code changes (`git diff --stat`) for the configured `progress_timeout_mins` duration (e.g., 15 minutes), it is assumed to be stuck in a runaway hallucination loop. 

**Triggered AI Review**: When the Reviewer Timeout trips, the loop does *not* blindly restart the agent. Instead, it extracts the last 50 lines of the stuck agent's logs and spawns a single, stateless, headless LLM call (using the Worker CLI) with a targeted system prompt:
> *"This agent is stuck. Look at its last 50 lines of logs. What is it failing to understand? Write a 1-sentence instruction I can send it to break it out of this loop."*

The loop then uses this AI-generated instruction as the prompt for the `soft_restart`, ensuring the agent gets intelligent course-correction without the massive token cost of continuous monitoring.

### Action Types

| Action | Effect |
|--------|--------|
| `end_agent` | Orchestrator loop runs the agent's `validation_command` (if configured) inside its worktree. If it **passes**, it sends SIGTERM and marks it `"completed"`. If it **fails**, the loop automatically triggers a `soft_restart`, packaging the stderr/stdout back to the agent with instructions to fix its code. |
| `soft_restart` | Orchestrator loop kills the rogue process, creates a `WIP` commit to preserve uncommitted work, and respawns the agent with new `instruction`s (e.g., test failure logs or the course-correction instruction generated by the Triggered AI Review) so it can correct its course. |
| `hard_restart` | Orchestrator loop kills the process, captures any uncommitted+untracked work as a `recovery/<agent>/<timestamp>` git tag, then resets the worktree clean and respawns the agent. The tag preserves the wiped state so it can be inspected with `git show <tag>` or recovered later. Useful for escaping hallucination loops. |

**Restart cap:** Every restart (soft or hard, whether triggered by validation failure, the AI-Review course-correction, or an orchestrator action) increments the agent's `restart_count`. Once it exceeds `default_max_restarts` (default 3), the loop stops respawning the agent and marks it `errored` so failures can't thrash forever.

**PID safety:** Before sending any signal the loop validates that the stored PID still matches the spawned worker CLI's command line (POSIX `ps`). If the PID has been recycled to an unrelated process, the signal is skipped — so the orchestrator cannot accidentally SIGTERM an editor or shell that happens to inherit the worker's old PID.

**Aborting:** Closing the dashboard window (SIGHUP/SIGTERM) leaves the agents running. Pressing Ctrl+C asks for confirmation, then writes `coord/abort.flag`. The loop's abort path performs a soft stop only — it kills the running agent processes and marks them `terminated`, but **does not** `git reset --hard` the worktrees. Any in-flight work is preserved and can be inspected with `git status` in each worktree.

**Stalled CLI surfacing:** If the orchestrator CLI fails `claude_failure_threshold` cycles in a row (default 5), the loop writes `coord/orchestrator-stalled.flag` with a diagnostic payload. The dashboard renders a red banner so you can see at a glance that arbitration is stuck (e.g., `claude` is unauthenticated, rate-limited, or down). The flag is removed automatically as soon as a cycle succeeds.

## Phase 6 — Review and Integration

When all worker agents finish, the `orchestrator-loop.js` script will automatically:
1. **Collect Diffs**: Gather git stats and diffs from all completed agent worktrees.
2. **AI Summary**: Spawn a final **worker agent session** (using the same CLI the workers used) to generate a concise, plain-text review summary at `coord/review-summary.txt`.
3. **Optional Popup Notification**: If `launch_review_terminal` is enabled, open a **new terminal window** displaying this summary.
4. **Exit**: The orchestrator loop will then safely terminate.

At this point, the user will return to Claude. They can either use their original chat window, or open a completely new chat window. They will give you a command like *"The agents are done. Please review and integrate their work."*

When you receive this instruction to perform the final integration, you should:
1. Identify the completed agent worktrees (look in both `.kilocode/worktrees/` and `.agents/worktrees/`).
2. Run `git diff main...<agent-name>` for each to review the code.
3. Provide a summary of the work to the user.
4. Once the user approves, perform the merge:
   ```bash
   git merge <agent-name>
   git worktree remove <worktree-path>/<agent-name>
   git branch -d <agent-name>
   ```

## For Maintainers

Run `node scripts/run-tests.js` to syntax-check scripts and execute dependency-free smoke tests.
