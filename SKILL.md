---
name: multi-agent-orchestrator
description: Decompose a large coding task into parallel worker agents (Kilo, Aider, Claude, Codex, Gemini, OpenCode) running in isolated git worktrees with self-healing supervision. Use when the user asks to "build something complex with multiple agents", "split this work in parallel", "spawn a swarm", or to coordinate background headless CLI workers.
---

# Multi-Agent Orchestrator Skill

This skill defines a caller-neutral, CLI-agnostic multi-agent orchestration system.

## Prerequisites & Recommendations
Before using this skill, ensure you have:
1. **A Headless Worker CLI**: Installed globally. This skill uses `kilo` (Kilo Code) by default, but it can orchestrate **Aider**, **Claude Code**, **Gemini**, **Codex**, **OpenCode**, or any other CLI added to `cli_templates` in `orchestrator.config.jsonc`. **Important:** The CLI must be fully configured ahead of time (e.g., signed in, API keys set, model selected, codebase context loaded, etc.). Because the agents run headlessly in the background **non-interactively**, they will crash or hang if they encounter interactive setup prompts.

## Caller Support

Use this workflow from any local coding-agent caller that can read `SKILL.md` and run shell commands:

- **Codex**: Install this folder as a Codex skill. `agents/openai.yaml` provides Codex UI metadata, and `AGENTS.md` provides a short repository-level caller guide.
- **Gemini CLI**: Install this folder as a Gemini extension. `gemini-extension.json` loads `GEMINI.md`, which imports this `SKILL.md`; `skills/multi-agent-orchestrator/` exposes a native skill wrapper; and `commands/multi-agent-orchestrator.toml` exposes a `/multi-agent-orchestrator` command.
- **Claude Code**: Install this folder as a Claude Code skill.
- **Other local callers**: Explicitly instruct the caller to read this `SKILL.md` and use the absolute path to this repository when running scripts.

The runtime itself is independent of the caller. The caller only performs decomposition, file edits, script launches, and final integration.


> **Architectural Recommendation & Intelligence Boundaries:**
> This skill is optimized to keep architectural judgment in the interactive caller session while using configurable CLIs only where headless execution is necessary. It relies on **three distinct contexts**:
>
> 1. **Initial Decomposition (Interactive Session):** Your active caller session is the primary architect. It analyzes the task, chooses the topology, writes or edits the draft plan, materializes `coord/context.json`, and launches workers only after approval.
> 2. **The Background Orchestrator Loop (Headless Script):** Once launched, the background loop has **no access to your chat history**. It invokes **`orchestrator_cli`** only for request arbitration: pending worker questions, synthetic `progress_timeout` requests, and `end_agent` / `soft_restart` / `hard_restart` actions. If omitted, `orchestrator_cli` follows `default_cli`.
> 3. **Final Integration (Interactive Session):** After the background loop completes, it writes a deterministic `coord/review-summary.txt` from worker self-reports. You return to the caller session to review diffs and safely merge completed worktrees.
>
> **Model Selection Strategy:** Use a powerful reasoning model for your interactive caller sessions (Contexts 1 & 3). Configure your **Worker CLI** (`default_cli`) to use cost-efficient fast models for bulk coding. Set `orchestrator_cli` only when request arbitration should use a different CLI/model from the workers.
>
> **How to pin a model:** Two patterns depending on the CLI.
> - **Inline-flag CLIs** (claude, aider, gemini): model selection is part of `cli_templates`. Prefer structured argv templates and add the CLI's model flag in `args` — e.g. `{ cmd: "claude", args: ["-p", { prompt_text: true }, "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6"] }` for Sonnet, or add `--model gpt-4o-mini` to the Aider args.
> - **External-config CLIs** (kilo, opencode, codex): model selection lives in the CLI's own settings (BYOK provider + model picker), not the template. The template stays simple; the model is whatever the user has configured in that CLI.
>
> **`claude` is the one CLI where pinning is effectively required, not optional.** The other inline-flag CLIs (aider, gemini) read their model from independent config (env vars, model files), so a worker spawn picks up the user's existing setup. `claude` is different when this runtime is launched from Claude Code — without `--model`, the spawned worker can inherit the model of the parent Claude Code session running this skill (for example, an expensive high-tier orchestrator model), routing bulk worker coding to the orchestrator's model. The shipped `cli_templates.claude` already pins Sonnet 4.6 for this reason.
>
> There is intentionally no separate `default_model` config key, because each CLI uses different flag names and model-id namespaces (and some don't take a flag at all), so keeping it close to the actual mechanism avoids a leaky aliasing layer.
>
> **Recommended default combination:** `default_cli: kilo` + DeepSeek V4 Pro (`deepseek-v4-pro`, 1M context, cheap and fast). Because Kilo is an external-config CLI, set this up by configuring DeepSeek as a BYOK provider in Kilo and selecting `deepseek-v4-pro` in its model picker — `cli_templates.kilo` does not need to change. Then run `node <skill>/scripts/preflight.js` to confirm the chain (API key + provider + model selection) is actually exercising the API, not just confirming the binary is installed.

## ⚙️ Configuration (`orchestrator.config.jsonc`)
Before beginning Phase 1, you MUST check if an `orchestrator.config.jsonc` file exists in the project root. This JSONC file acts as the shared source of truth for project/team preferences. The loader also accepts pure `orchestrator.config.json` and legacy executable `orchestrator.config.js`; if multiple shared files exist, preference order is JSONC, then JSON, then JS.

After the shared config, the loader applies an optional untracked local override file: `orchestrator.config.local.jsonc` (or pure `orchestrator.config.local.json`). Use it only for personal machine-specific differences such as local CLI choice, dashboard behavior, or local wrapper commands. It can be as small as `{}` and should not duplicate shared defaults.

The shipped config includes a `$schema` reference to the published `references/orchestrator-config.schema.json`. Editors that understand JSON Schema use it for autocomplete, descriptions, allowed values, and validation, so optional settings should be discovered through completion instead of commented-out duplicate config blocks.

If it exists, read it to determine:
- **`default_cli`**: The Worker CLI to use for spawning coding agents.
- **`orchestrator_cli`**: Optional CLI used by the background loop for request arbitration. If omitted, it follows `default_cli`. Set this independently from `default_cli` only when you want arbitration to use a different CLI/model than your workers.
- **`cli_templates`**: The template definitions used to spawn worker CLIs and drive `orchestrator_cli` arbitration calls. Prefer structured `{ cmd, args }` entries so they run with `shell:false`; keep string templates when you intentionally need shell behavior. **This is also where you pin a model** — add the CLI's model flag (`--model <id>`, `--llm <id>`, etc.) to the template args/string and that model is used for every spawn driven by it.
- **`reviewers`**: Optional Phase 1.5 read-only plan reviewer CLIs. Each entry has `name`, `cli`, `review_focus`, optional `model`, optional `model_flag`, optional `template_args`, and optional `timeout_mins`. Every reviewer `cli` must have matching `cli_templates.<cli>` and `cli_health_checks.<cli>` entries.
- **`max_plan_review_iterations`**: `"auto"` by default, or a positive integer. In `"auto"` mode, run at least one review iteration when reviewers are configured, then explicitly decide after reconciliation whether another pass is worth it. Numeric mode means run exactly that many iterations.
- **`default_timeout_mins`**: The default time before an agent is considered hanging (Liveness).
- **`default_progress_timeout_mins`**: The default time before an active agent with zero code changes is considered stuck (Progress).
- **`default_max_restarts`**: The maximum number of times the loop will respawn the same agent before marking it `errored` (defaults to 3). Counted across validation-failure restarts, progress-timeout arbitration restarts, and explicit arbitrator restarts.
- **`orchestrator_failure_threshold`**: Consecutive arbitration-CLI failures before the loop writes `coord/orchestrator-stalled.flag` (which the dashboard surfaces). Defaults to 5. `claude_failure_threshold` remains accepted as a deprecated alias for existing configs.
- **`poll_min_ms` / `poll_max_ms`**: Adaptive polling bounds for the orchestrator loop. The loop polls at `poll_min_ms` (default 1000) right after seeing pending requests, then exponentially backs off (×1.5 per idle cycle) up to `poll_max_ms` (default 15000). Pass `--poll-interval <ms>` to the loop to disable the heuristic and force a fixed cadence.
- **`cli_health_checks`**: Per-CLI probe commands run by `scripts/preflight.js` to fail fast on install / auth issues. Defaults to `<cli> --version` for every supported CLI.
- **`launch_dashboard` / `launch_review_terminal`**: Optional GUI terminal auto-launch. `launch_dashboard` defaults to `"auto"`: it opens a dashboard terminal on local macOS, skips auto-launch in CI/SSH/non-macOS, and can be forced with `true` or disabled with `false`.

Example `orchestrator.config.jsonc`:
```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hyw007726/multi-agent-orchestrator-skill/main/references/orchestrator-config.schema.json",

  // The background CLI worker to execute tasks.
  "default_cli": "kilo",

  // Command templates for supported CLIs.
  // Prefer structured argv templates. Use { "prompt_file": true } to pass the
  // generated prompt file path as one argv item, or { "prompt_text": true } to pass
  // the prompt contents as one argv item. String templates remain supported for
  // CLIs that genuinely need shell behavior.
  "cli_templates": {
    "kilo": "kilo run \"$(cat {prompt_file})\" --auto",
    "aider": { "cmd": "aider", "args": ["--message-file", { "prompt_file": true }, "--yes"] },
    "claude": { "cmd": "claude", "args": ["-p", { "prompt_text": true }, "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6"] },
    "gemini": { "cmd": "gemini", "args": ["--prompt", { "prompt_text": true }, "--yolo"] },
    "codex": { "cmd": "codex", "args": ["exec", "--dangerously-bypass-approvals-and-sandbox", { "prompt_text": true }] },
    "opencode": { "cmd": "opencode", "args": ["run", { "prompt_text": true }, "--yes"] }
  }
}
```

If no shared or local config file exists, you MUST dynamically evaluate the overall size and complexity of the user's project to determine sensible default bounds (e.g., a simple script might only need a 5-minute progress timeout and 3 iterations, while a complex React app might need a 20-minute progress timeout and 10 iterations). You can also offer to create the shared config file for the user so they can explicitly customize workflow bounds in the future!

> **Note:** All worker CLIs are automatically launched with their respective "bypass permissions" flags (`--yes`, `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--auto`) so they run fully autonomously in the background. The Orchestrator Loop will remember which CLI tool you spawned the agent with and will automatically use the exact same tool if it needs to respawn the agent after a rollback!

## Phase 0 — Setup

These three steps run unconditionally on every invocation, before any task reasoning begins.

**Step 1 — No setup required:** The skill has no external dependencies — all scripts use Node.js built-in modules only. No `npm install`, no global packages, no build step. Proceed directly to Step 2.

**Step 2 — Read configuration:** Read `orchestrator.config.jsonc` from the project root, falling back to `orchestrator.config.json` or legacy `orchestrator.config.js`, then apply optional `orchestrator.config.local.jsonc` / `orchestrator.config.local.json`, to load the user's preferred CLI and default bounds.

**Step 3 — Preflight CLI health check (REQUIRED):** Verify the worker CLI and orchestrator CLI are runnable before any decomposition or spawning — an unauthenticated CLI will hang on an interactive prompt for the full liveness timeout otherwise.

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/preflight.js
```

The script checks `default_cli`, `orchestrator_cli`, and any configured plan reviewer CLIs by default. Before probing, it prints a model heads-up: pinned template models are shown by name, external-config CLIs are called out as using their own selected provider/model, and reviewer-specific `model` / `template_args` overrides are listed. It then runs two probes per CLI: a `--version` install check, then an auth probe that exercises the spawn template with a tiny prompt to verify API keys, BYOK provider configuration, and model selection. Pass `--skip-auth` for install-only checks (CI / offline). If any check fails, abort and surface the diagnostic — typical fixes are installing the CLI, putting it on `$PATH`, signing in, or selecting a default model.

## Phase 1 — Task Evaluation, Topology Selection & Decomposition

Evaluate whether the user's overall task is suitable for multi-agent orchestration.
- Before splitting work, propose an execution topology:
  - `direct`: small or tightly coupled sequential work that does not justify orchestration. Stop using this skill for the task; handle it in the caller session and do not bootstrap or launch workers.
  - `single_worker`: substantial but mostly sequential work that benefits from delegated background execution. Create exactly one worker task.
  - `parallel`: genuinely independent task boundaries with non-overlapping file ownership and worker-specific validation. Use this only when workers can proceed at the same time safely.
  - `phased`: shared foundations must be handled first, then independent leaves can fan out to workers. Implement and commit the shared foundation in the caller session before writing the final worker task map.
- Record the candidate topology before decomposition: `execution_mode`, rejected alternatives with reasons, `reason`, `dependency_notes`, shared-foundation notes, and the mode-specific task decomposition.
- Treat the topology as a candidate until after optional Phase 1.5 review and reconciliation. The main caller may change the mode before writing final `coord/context.json`, or decide not to launch workers.
- **Handle Overlapping Foundations First (CRITICAL):** True non-overlapping boundaries are rare. If agents will need to touch shared files (e.g., `package.json`, generic `types.ts`, test config, database schemas, router setups), **you must handle these sequentially before spawning agents.** If you spawn parallel worktrees that modify the same foundational files, you will create impossible merge conflicts.
  - *Action:* Tell the user: "I need to set up the shared foundation (schemas, package.json, etc.) first to prevent merge conflicts."
  - *Action:* Implement these shared foundations yourself in the current session.
  - *Action:* Commit the foundation.
  - *Action:* Only then, split the remaining work into truly parallel, isolated agent tasks.
- **Proceed** only for `single_worker`, `parallel`, or `phased` after the foundation is either already set or has just been completed by you.

If proceeding:
1. Break the work down into non-overlapping agent boundaries.
2. Explicitly map out what files each agent is allowed to touch.
3. List `read_first` files/paths for each agent so workers begin with targeted source context instead of broad repo scans.
4. Determine a `validation_command` for each agent. **Prefer JSON-argv form** so the loop can run it with no shell expansion (e.g. `--validate '["npm","run","test","--","src/foo"]'`); fall back to a shell string only when you need pipes / `&&` / env expansion (e.g. `--validate "npm run lint && npm test"`). Use `null` if no automated validation is possible/needed.
5. Prepare a mapping of agent names to their task descriptions.

### Guided Starter Helper

Instead of running the starter scripts one by one, the caller may use the guided helper from the target project root:

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/prepare-run.js \
  --project "Short project description" \
  --task "The user's requested implementation" \
  --coord ./coord
```

Default mode runs preflight, bootstraps `coord/` when needed, writes a caller-authored `coord/plan-reviews/draft-plan-v1.json` template plus `draft-plan-v1.instructions.md`, and then stops. The caller session must replace every TODO placeholder, choose the topology, define worker boundaries, and review the draft before approval.

After caller approval:

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/prepare-run.js \
  --approve-draft \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

Approval mode materializes `context.json`, `DECISIONS.md`, and `CALLER_CONTEXT.md`, validates the generated context, and prints the final `launch-all.js` command. It still does not launch workers automatically.

## Phase 1.5 — Optional Plan Review

If `reviewers` is configured, do not write the final `coord/context.json` task map yet. First draft the decomposition as `coord/plan-reviews/draft-plan-v1.json`. The caller session should normally write this draft itself. If you explicitly want an optional read-only helper, you may run:

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/draft-plan.js \
  --task "The user's requested implementation" \
  --project "Short project description" \
  --coord ./coord
```

The optional helper uses `orchestrator_cli` (falling back to `default_cli` through normal config), writes `coord/plan-reviews/draft-plan-v1.prompt.md`, `coord/plan-reviews/draft-plan-v1.raw.md`, and the canonical `coord/plan-reviews/draft-plan-v1.json`, and must not launch workers or edit project files. The caller still owns review and approval. Include the user requirements, constraints, candidate execution topology, rejected topology alternatives, topology reason, dependency notes, candidate file ownership, shared-foundation assumptions, mode-specific task decomposition, validation commands, known risks, and any sequencing dependencies.

Run one read-only review iteration:

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/review-plan.js \
  --iteration 1 \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

The runner invokes all configured reviewers in parallel for that iteration and writes:
- live reviewer streams to `coord/plan-reviews/iteration-<N>/<reviewer>.md`;
- parsed valid reviewer JSON to `coord/plan-reviews/iteration-<N>/<reviewer>.json`;
- the draft plan audit copy to `coord/plan-reviews/draft-plan-v<N>.json`.

Each reviewer must return JSON with `iteration`, `reviewer`, `summary`, `execution_mode_issues`, `blockers`, `overlaps`, `missing_foundation_work`, `sequencing_risks`, `validation_gaps`, and `suggested_changes`. Reviewers must critique both the selected execution mode and the resulting task decomposition, including whether the mode is too heavy, too weak, incorrectly sequenced, whether `parallel` should really be `phased`, whether `single_worker` or `direct` would avoid unnecessary coordination, and whether worker boundaries are safe for the chosen mode. Invalid JSON is a reviewer failure, but the workflow can continue if at least one reviewer returns valid JSON.

After every iteration, the main caller reconciles the feedback and writes `coord/plan-reviews/iteration-<N>/reconciliation.json` with accepted and rejected feedback plus rationale. Reviewer feedback informs the final decomposition, but reviewers never mutate `coord/context.json` or `coord/DECISIONS.md` directly.

If `max_plan_review_iterations` is a positive integer, run exactly that many iterations, writing an updated `draft-plan-v<N+1>.json` and passing the prior reconciliation before each later iteration:

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/review-plan.js \
  --iteration 2 \
  --draft-plan ./coord/plan-reviews/draft-plan-v2.json \
  --previous-reconciliation ./coord/plan-reviews/iteration-1/reconciliation.json \
  --coord ./coord
```

If `max_plan_review_iterations` is `"auto"`, run at least one iteration and then stop after each reconciliation to explicitly decide whether another pass is worth running. Do not let the runner self-continue. Reviewers never chat with each other; the main caller owns synthesis between iterations. Only after reconciling the final chosen/configured iteration should you write the final `coord/context.json` and update `coord/DECISIONS.md`.

To materialize an approved draft plan into the launchable coordination files, either edit `coord/context.json` and `coord/DECISIONS.md` manually, or run:

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/materialize-plan.js \
  --draft-plan ./coord/plan-reviews/draft-plan-v1.json \
  --coord ./coord
```

The materializer preserves existing compact `chat_context`, writes the final execution topology and task map to `context.json`, writes topology rationale, rejected alternatives, shared-foundation assumptions, durable requirements, constraints, file ownership, sequencing notes, validation commands, and known risks to `DECISIONS.md`, writes user intent, important chat nuance, environment assumptions, and non-durable rationale to `CALLER_CONTEXT.md`, then validates the generated context. It refuses to overwrite an existing non-empty task map unless `--force` is passed. If the final topology is `direct`, it writes no worker tasks and tells the caller not to run `launch-all.js`.

## Phase 2 — Bootstrap
When starting a new orchestrated project, create the `coord/` directory at the project root and initialize these files.

**Important Path Resolution:** The scripts required for this workflow are located in the `scripts/` directory next to this `SKILL.md` file. Before running the commands below, determine the absolute path to this skill folder (e.g., if you are reading this from `~/Desktop/multi-agent-orchestrator/SKILL.md`, the path is `~/Desktop/multi-agent-orchestrator`).

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/bootstrap.js \
  --project "Your project description" \
  --coord ./coord
```

### `coord/context.json`
Because the orchestrator loop runs after your interactive caller session is done, it has **zero access** to your original chat history. **You must heavily compress all user preferences, architectural nuances, and conversational context into a structured `chat_context` object.** Keep `context.json` compact: it is serialized into arbitration prompts. Do not paste long specs, transcripts, file contents, or diffs here.

You should also include the final execution topology and the tasks you generated in Phase 1 under the `"tasks"` key. If the final mode is `direct`, do not create or launch an orchestrated run.

`bootstrap.js` only scaffolds an empty skeleton (`chat_context: {}`, `execution_topology: { execution_mode: "", reason: "", dependency_notes: [] }`, `tasks: {}`). After running it, edit `context.json` with the structured shape below or run `scripts/materialize-plan.js` from an approved draft before you spawn any workers. Put durable requirements, architecture, shared contracts, topology rationale, and file ownership in `coord/DECISIONS.md`; put user intent, important chat nuance, environment assumptions, and non-durable rationale in `coord/CALLER_CONTEXT.md`; use `context.json` as the compact run index.

```json
{
  "project": "<one-line description of the user's task>",
  "chat_context": {
    "preferences": ["<e.g., Use explicit typing>", "<e.g., Prefer functional components>"],
    "architecture": ["<e.g., MVVM pattern>", "<e.g., Redux for state>"],
    "naming_conventions": ["<e.g., camelCase for variables>", "<e.g., PascalCase for interfaces>"],
    "gotchas": ["<e.g., User is using an older version of Node>"]
  },
  "execution_topology": {
    "execution_mode": "<single_worker | parallel | phased>",
    "reason": "<why this topology is the right amount of orchestration>",
    "dependency_notes": ["<shared foundations already committed, fan-out dependencies, or sequencing constraints>"]
  },
  "requirements": ["<compact requirement summary 1>", "<compact requirement summary 2>"],
  "constraints": ["<compact constraint summary 1>", "<compact constraint summary 2>"],
  "created_at": "<ISO 8601 timestamp>",
  "tasks": {
    "agent-name": {
      "description": "description of the boundary",
      "read_first": ["src/path/to/read.ts", "tests/path/to/read.test.ts"],
      "allowed_paths": ["src/owned/**", "tests/owned/**"],
      "forbidden_paths": ["package.json", "coord/"],
      "validation_command": ["npm", "test", "--", "owned"],
      "timeout_mins": 10,
      "progress_timeout_mins": 15
    }
  }
}
```

### `coord/DECISIONS.md`
To ensure critical architectural rules are never lost in JSON compression, write a human-readable `coord/DECISIONS.md` file. This file is the curated source of truth for durable requirements, shared API contracts, data models, file ownership, and structural decisions made in Phase 1. The background loop includes `DECISIONS.md` in arbitration prompts, preserves approved request resolutions in `coord/decisions.jsonl`, and keeps only the latest 30 in `coord/decisions.json`; it does not automatically rewrite `DECISIONS.md`. If a runtime approval should become durable project policy, update `DECISIONS.md` from the orchestrator session.

### `coord/CALLER_CONTEXT.md`
To keep `context.json` compact while still giving the headless loop enough caller context, write a human-readable `coord/CALLER_CONTEXT.md` file. This file is for compressed user intent, important chat nuance, local environment assumptions, and temporary planning rationale that should not become durable project policy. The background loop includes it in arbitration prompts and worker restart prompts. Workers are instructed to read it after `DECISIONS.md`. Do not put stable architecture contracts or file ownership rules here; those belong in `DECISIONS.md`.

### Validating the materialized context

Before launching, you can confirm `coord/context.json` is launchable with the shared validator:

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/validate-context.js --coord ./coord
```

The validator checks the execution topology, per-task name safety, allowed/forbidden path shape, CLI references against `cli_templates`, and common foundation-path leaks. `scripts/materialize-plan.js`, `scripts/prepare-run.js --approve-draft`, and `scripts/launch-all.js` all call the same validator internally; running it standalone is useful after hand-edits to `context.json`.

## Phase 3 — Prompt Generation

Prompts are rendered automatically by `scripts/launch-all.js` during Phase 4; the orchestrator session no longer hand-substitutes placeholders. `launch-all.js` reads `references/worker-prompt-template.md` and machine-substitutes the placeholders defined in the grammar table of `references/schemas.md` from each agent's `tasks{}` record. Ensure every agent record is fully populated before you launch.

## Phase 4 — Launch

```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/launch-all.js --coord ./coord
```

`launch-all.js` first runs the shared `validateContext` check against `coord/context.json` and aborts with a diagnostic before any worktree is created if the context is not launchable (bad topology, missing/forbidden paths, broken CLI references, foundation-path leaks). When validation passes, it iterates every entry under `tasks{}`, and for each agent: creates a git worktree at `.kilocode/worktrees/<agent>` (Kilo) or `.agents/worktrees/<agent>` (other CLIs), renders the worker prompt by machine-substituting the placeholders defined in `references/schemas.md`, writes the rendered prompt to a tmp file, and shells out to `scripts/spawn-agent.js`. After every `spawn-agent` call succeeds, it backgrounds `scripts/orchestrator-loop.js` with `nohup` and exits non-blocking.

On success it prints a one-line summary per agent (name, PID, log path), the orchestrator loop PID, and a dashboard hint. On failure it stops the loop, leaves already-spawned agents alive for inspection, and exits non-zero with a diagnostic.

**Once the loop is started, your job as the starter session is done. You should politely inform the user that the orchestration loop is running in the background and exit.**

> **Tip for Kilo Code Users:** Because the agents are physically spawned inside the `.kilocode/worktrees/` directory path by default, they will automatically appear in your **Kilo Code Agent Manager UI** inside VS Code! You can monitor the specific files they are editing in real-time natively in your IDE.

By default the dashboard auto-launches on local macOS and stays manual in CI/SSH/non-macOS environments. To monitor progress manually, run:
```bash
node <ABSOLUTE_PATH_TO_THIS_SKILL_FOLDER>/scripts/dashboard.js --coord ./coord
```

### Progress Monitoring
The orchestrator loop doesn't just watch for crashes; it monitors for **actual code progress**.
- **The "Killer" Timeout (Liveness Detection)**: If an agent stops emitting logs for the configured `timeout_mins` duration, it is assumed hanging, killed, and marked as errored.
- **Progress Timeout (Progress Detection)**: If an agent is alive but fails to accumulate any git commits or unstaged code changes (`git diff --stat`) for the configured `progress_timeout_mins` duration (e.g., 15 minutes), the loop writes a synthetic `progress_timeout` request into `coord/requests.jsonl` for normal arbitration.

**Progress heartbeat**: Workers may write optional heartbeat files to `coord/progress/<agent>.json` using atomic tmp-file rename. These files can include `phase`, `summary`, `last_action`, `blocker`, and `updated_at`. The loop uses filesystem modification time as the wall-clock signal; models are not expected to perceive elapsed time accurately. A fresh heartbeat in an expected non-editing phase such as `reading`, `planning`, `testing`, `building`, `installing`, or `debugging` can grant one bounded progress grace after the last code change.

**Synthetic progress-timeout request**: The generated request includes a deterministic recommended instruction, escalation fields (`escalation_level`, `progress_timeout_count`, `restart_count`, `restarts_remaining`, `suggested_action`), the current task, allowed/forbidden path context, validation command, heartbeat snapshot, diff/progress snapshot, and the last 50 log lines. The existing `orchestrator_cli` arbitration path decides whether to `soft_restart`, `hard_restart`, wait, or reject for manual inspection. This avoids a separate one-off review LLM call while keeping stall handling in the same decision log as worker questions.

**Escalation ladder**: The first progress timeout recommends a deterministic `soft_restart`; the second recommends a stronger `soft_restart`; the third and later timeouts recommend `hard_restart` unless a recovery tag already exists or the restart budget is exhausted, in which case the request recommends manual inspection. The arbitrator still makes the final decision.

### Action Types

| Action | Effect |
|--------|--------|
| `end_agent` | Orchestrator loop runs the agent's `validation_command` (if configured) inside its worktree. If it **passes**, it auto-commits any uncommitted worker changes (`git add -A` + `git commit -m "agent-<name>: <task>"`) so the final merge picks them up, sends SIGTERM, and marks the agent `"completed"`. If validation **fails**, the loop automatically triggers a `soft_restart`, packaging the stderr/stdout back to the agent with instructions to fix its code. |
| `soft_restart` | Orchestrator loop kills the rogue process, creates a `WIP` commit to preserve uncommitted work, and respawns the agent with new `instruction`s (e.g., test failure logs or an instruction approved during progress-timeout arbitration) so it can correct its course. |
| `hard_restart` | Orchestrator loop kills the process, captures any uncommitted+untracked work as a `recovery/<agent>/<timestamp>` git tag, then resets the worktree clean and respawns the agent. The tag preserves the wiped state so it can be inspected with `git show <tag>` or recovered later. Useful for escaping hallucination loops. |

**Restart cap:** Every restart (soft or hard, whether triggered by validation failure, progress-timeout arbitration, or an orchestrator action) increments the agent's `restart_count`. Once it exceeds `default_max_restarts` (default 3), the loop stops respawning the agent and marks it `errored` so failures can't thrash forever.

**PID/process-group safety:** Before sending any signal the loop validates that the stored PID still matches the spawned worker CLI's command line (POSIX `ps`). If the PID has been recycled to an unrelated process, the signal is skipped. On POSIX the worker is launched as a detached process group, so stops/restarts signal the whole group rather than only the wrapper PID.

**Aborting:** Closing the dashboard window (SIGHUP/SIGTERM) leaves the agents running. Pressing Ctrl+C asks for confirmation, then writes `coord/abort.flag`. The loop's abort path performs a soft stop only — it kills the running agent processes and marks them `terminated`, but **does not** `git reset --hard` the worktrees. Any in-flight work is preserved and can be inspected with `git status` in each worktree.

**Stalled CLI surfacing:** If the orchestrator CLI fails `orchestrator_failure_threshold` cycles in a row (default 5), the loop writes `coord/orchestrator-stalled.flag` with a diagnostic payload. The dashboard renders a red banner so you can see at a glance that arbitration is stuck (e.g., the configured `orchestrator_cli` is unauthenticated, rate-limited, or down). The flag is removed automatically as soon as a cycle succeeds.

**Event log:** Every state transition the loop and `spawn-agent.js` make — spawns, completions, validation failures, restart scheduling, recovery-tag creation, heartbeat graces, abort signals — is appended as a structured JSON line to `coord/events.jsonl`. It is best-effort and append-only; failures to write are swallowed. Use it as the chronological audit trail when reconstructing what happened in a finished run.

## Phase 5 — Review and Integration

When all worker agents finish, the `orchestrator-loop.js` script will automatically:
1. **Aggregate Worker Self-Reports**: Read `agents.json` and each worker's resolved `review_request` content.
2. **Write Deterministic Summary**: Generate `coord/review-summary.txt` without making a final AI call.
3. **Optional Popup Notification**: If `launch_review_terminal` is enabled, open a **new terminal window** displaying this summary.
4. **Exit**: The orchestrator loop will then safely terminate.

At this point, the user will return to the interactive orchestrator session. They can either use their original chat window, or open a completely new chat window. They will give you a command like *"The agents are done. Please review and integrate their work."*

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
