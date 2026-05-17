# TODO

Each item is tagged with a complexity rating:

- **[C1]** - small surgical change, single file, clear logic, low risk.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

# Foundation Pre-Spawn Hardening Plan

Goal: make "shared foundation must be complete before workers launch" enforceable enough that callers cannot accidentally fan out workers against missing, uncommitted, or ambiguously owned foundation work.

## Tasks

- **[C1] Done - Document runtime caveats clearly.**
  Added concise caveats sections to `README.md` and `SKILL.md` covering autonomous/yolo CLI modes, required preconfigured CLI auth, caller-owned final review/merge, and the remaining possibility of model-created conflicts.

- **[C2] Done - Add explicit foundation state to the plan schema.**
  Extended draft plans with a machine-readable `foundation` block:
  - `status`: `not_required`, `completed_committed`, or `owned_by_worker`.
  - `paths`: shared foundation paths or globs.
  - `commit`: required when `status` is `completed_committed`.
  - `owner`: required when `status` is `owned_by_worker`.
  Keep the human-readable `shared_foundation_notes` for rationale.

- **[C2] Done - Materialize foundation state into launch context.**
  Updated `scripts/materialize-plan.js` so approved draft foundation state is copied into `coord/context.json` and summarized in `coord/DECISIONS.md`. Workers see the final contract in `DECISIONS.md`; validators use the machine-readable context.

- **[C3] Done - Promote unsafe foundation conditions from warnings to launch blockers.**
  Updated `scripts/lib/context-validation.js` so `parallel` and `phased` launch validation fails when common or declared foundation paths are not either:
  - forbidden for every worker, or
  - explicitly owned by exactly one worker.
  Keep broad ownership overlap diagnostics, but make foundation leaks errors during launch validation.

- **[C2] Done - Detect uncommitted foundation work before launch.**
  Added a git check in validation that fails when `foundation.status` is `completed_committed` but any listed foundation path has uncommitted changes. This prevents workers from branching from `HEAD` without seeing caller-created foundation work.

- **[C2] Done - Add an explicit override for intentional exceptions.**
  If a project truly needs a worker to own a shared foundation file, ownership must be declared in the foundation block and repeated in `DECISIONS.md`. There is no broad `--force` that silently bypasses this check.

- **[C2] Done - Update starter and reviewer prompts.**
  Updated `scripts/prepare-run.js`, `scripts/draft-plan.js`, and `scripts/review-plan.js` so draft templates and reviewers explicitly ask whether foundation work is missing, committed, or owned by one worker.

- **[C2] Done - Test the new failure modes.**
  Added tests covering:
  - `phased` plan with `completed_committed` foundation and clean git status passes.
  - declared foundation path missing from worker `forbidden_paths` fails.
  - uncommitted changes in declared foundation paths fail.
  - exactly one declared owner can edit an owned foundation path.
  - `direct` and `single_worker` modes remain unaffected unless foundation state is declared inconsistently.

## Acceptance Criteria

- `launch-all.js` cannot spawn workers for `parallel` or `phased` plans with ambiguous foundation ownership.
- A caller-authored foundation commit is either referenced and clean, or the launch fails with a concrete diagnostic.
- `coord/DECISIONS.md` explains foundation ownership in human-readable form.
- Existing warning-only foundation behavior is preserved only for non-launch advisory validation, not for actual worker launch.
