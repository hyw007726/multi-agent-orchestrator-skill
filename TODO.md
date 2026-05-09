# TODO

Each item is tagged with a complexity rating:

- **[C1]** - small surgical change, single file, clear logic, low risk.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

Verify tests progress and coverage （claude）
Review the local/default configuration strategy (claude)

decide if we should should make all agents configurable, eg. starter agent, plan review agent, worker agent, arbitration agent, integrator agent

Lower model role play testing

## Worker Model Selection and Fallbacks

- **[C2] Add conditional worker-model selection prompt**
  - If no `orchestrator.config.js` exists, prompt the user before launch with a default recommendation: use a secondary-tier model from the caller's provider family for worker agents.
  - If preflight fails because the configured worker CLI/model is unavailable, prompt the user to switch to a secondary-tier same-provider worker model or edit config manually.
  - Make the prompt explicit about what will be used, which config field will be written, and that workers run autonomously.
  - Persist the accepted choice into local `orchestrator.config.js`; do not keep an invisible in-memory model choice.
  - Rerun preflight after writing the choice and only proceed if it passes.
  - Skip the prompt when the user already has an explicit working `default_cli` / `cli_templates` setup.

- **[C2] Define provider-family secondary-tier recommendations**
  - Maintain a small provider-family mapping for recommendations, refreshed in docs over time: OpenAI/Codex, Anthropic/Claude, and Gemini.
  - Prefer secondary-tier coding-capable models over the absolute cheapest models.
  - Keep the mapping advisory; users can override it in config.
  - If the caller/provider cannot be inferred, fall back to asking the user to choose or edit config rather than guessing.

- **[C2] Add provider-aware preflight fallback guidance**
  - When preflight auth/model checks fail for configured worker or reviewer CLIs, print targeted guidance instead of silently changing models.
  - Detect provider family from the CLI name and/or pinned model id when possible (`openai`, `anthropic`/`claude`, `gemini`).
  - Suggest a faster or more cost-efficient model from the same provider family only as a user action, not as an automatic runtime mutation.
  - Keep suggestions conservative: prefer balanced coding models before the cheapest tier.
  - Include the exact config location to edit, such as `cli_templates.<cli>` for inline-flag CLIs or the external CLI's own model picker/provider settings for CLIs like `kilo`, `codex`, and `opencode`.
  - If provider cannot be inferred, print generic guidance to pick a configured, non-interactive, cost-efficient worker model and rerun preflight.

- **[C2] Document local config override as the source of truth**
  - Explain that built-in defaults avoid surprise, while project-local `orchestrator.config.js` should control worker CLI/model choices.
  - Document example overrides for OpenAI/Codex, Claude, and Gemini workers.
  - Warn that automatic "use the caller's lower model" inference is unreliable unless the caller writes the resolved choice into config.
  - Consider a future user-level config path such as `~/.opencabinet/config.js`, with project config taking precedence.

## Optional Plan Reviewer CLI Agents

- **[C3] Add simple `reviewers` configuration support**
  - Add an optional `reviewers` list to `orchestrator.config.js`.
  - Add `max_plan_review_iterations`, defaulting to `"auto"` and also accepting a positive integer.
  - Each reviewer entry should include a stable `name`, `cli`, optional `model`/template-specific args when supported by that CLI, and a short `review_focus`.
  - Reuse the same configured reviewer list for every review iteration; do not require callers to configure per-round reviewer lists.
  - Validate that every configured reviewer CLI has a matching `cli_templates.<cli>` entry and health check coverage.
  - Keep this feature opt-in; the normal Phase 1 decomposition flow should remain unchanged when no reviewers are configured.

- **[C3] Define the iterative review protocol**
  - The main caller drafts an initial plan as `draft_plan_v1`.
  - If reviewers are configured and `max_plan_review_iterations` is `"auto"`, run at least one review iteration.
  - After each `"auto"` iteration, the main caller reconciles feedback, records accepted/rejected feedback with rationale, writes the next draft plan when needed, and explicitly decides whether another review iteration is worth running.
  - If `max_plan_review_iterations` is a number, run exactly that many review iterations, with the main caller reconciling feedback between iterations.
  - Do not let the runner self-continue indefinitely in `"auto"` mode; each extra iteration must come from the main caller's explicit decision.
  - Each iteration reviews the latest draft plan plus any prior reconciliation notes.
  - The final decomposition is written only after the main caller has reconciled the last review iteration it chose or was configured to run.
  - Reviewers must never chat with each other directly; the main caller owns synthesis between iterations.

- **[C3] Insert a formal Phase 1.5 plan-review step before final decomposition**
  - After the main caller drafts the initial decomposition, run configured plan-review iterations before writing the final `coord/context.json` task map.
  - Reviewers should receive the latest draft plan, candidate file ownership, shared-foundation assumptions, validation commands, user requirements, constraints, known risks, and prior-iteration reconciliation notes when applicable.
  - Reviewers must be read-only: they critique the plan and must not edit repo files or launch workers.
  - The main caller remains the final decision-maker and must reconcile each iteration of reviewer feedback before advancing to the next iteration or committing to the final decomposition.

- **[C2] Define structured reviewer output**
  - Require JSON output with fields such as `iteration`, `reviewer`, `summary`, `blockers`, `overlaps`, `missing_foundation_work`, `sequencing_risks`, `validation_gaps`, and `suggested_changes`.
  - Treat invalid JSON as a reviewer failure, not as a blocker for the whole workflow unless all reviewers fail.
  - Stream each reviewer's in-progress output to `coord/plan-reviews/iteration-<N>/<reviewer>.md` while the main caller is waiting for reviews to complete.
  - Store parsed reviewer responses under `coord/plan-reviews/iteration-<N>/<reviewer>.json` for auditability when valid JSON can be extracted.
  - Store main-caller reconciliation notes as `coord/plan-reviews/iteration-<N>/reconciliation.json`.
  - Store each updated draft plan as `coord/plan-reviews/draft-plan-v<N>.json`.

- **[C2] Add a plan-review runner script**
  - Add a script such as `scripts/review-plan.js` that loads `orchestrator.config.js`, renders reviewer prompts for a specific iteration, invokes each configured CLI, and writes review artifacts.
  - Prefer parallel reviewer execution within an iteration because those reviews are independent.
  - Run iterations sequentially because each iteration reviews the latest reconciled plan from the previous iteration.
  - In `"auto"` mode, expose a single-iteration command that the main caller can run again after reconciliation when another pass is justified.
  - Stream reviewer stdout/stderr incrementally into reviewer-specific markdown files so the main caller can inspect live progress while waiting.
  - Support a timeout per reviewer and a clear failure summary.
  - Reuse the existing CLI template machinery instead of adding reviewer-specific shell handling.
  - Provide a way for the main caller to pass the latest draft plan path and previous reconciliation path into the runner.

- **[C2] Update skill instructions and schemas**
  - Document the new Phase 1.5 flow in `SKILL.md`.
  - Extend `references/schemas.md` with the `reviewers` / `max_plan_review_iterations` config shape and review artifact format.
  - Make clear that reviewer feedback informs the final decomposition but does not directly mutate `coord/context.json` or `coord/DECISIONS.md`.
  - Document that reviewer iterations are for decomposition quality only; implementation workers still launch only after final plan approval.

- **[C2] Improve preflight coverage for reviewers**
  - Update `scripts/preflight.js` so configured plan reviewer CLIs are included in health/auth checks.
  - Print reviewer model/template heads-up information alongside worker and orchestrator CLI checks.

- **[C2] Add tests**
  - Config parsing: no reviewers, reviewer list, `"auto"` review iterations, numeric review iterations, missing template, missing health check.
  - Runner behavior: successful reviews, invalid JSON, timeout, one reviewer failure among several, streamed markdown output, sequential iteration ordering.
  - Workflow safety: reviewer agents do not create worktrees, do not edit project files, and do not launch the background loop.
  - Reconciliation behavior: later iterations receive the updated draft plan and previous reconciliation notes, not the original stale plan.
  - Documentation/schema tests for the new config and artifact shape.


## Execution Topology Selection

- **[C2] Add execution topology selection before decomposition**
  - Let the interactive brain model decide between `direct`, `single_worker`, `parallel`, and `phased` modes before splitting work.
  - Use `direct` for small or tightly coupled sequential tasks that do not justify orchestration.
  - Use `single_worker` for substantial but mostly sequential tasks that benefit from background delegated execution.
  - Use `phased` when shared foundations must be handled first, then independent leaves can fan out to parallel workers.
  - Record `execution_mode`, `reason`, and `dependency_notes` in the run context so the choice is explicit and durable.
