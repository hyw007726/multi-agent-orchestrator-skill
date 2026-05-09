
## OpenCabinet Rebrand

- **[C2] Decide final public name and positioning**
  - Candidate brand: **OpenCabinet**.
  - Working subtitle: "Council-reviewed orchestration for parallel coding agents."
  - Keep "multi-agent orchestrator" in README copy for discoverability and migration clarity.
  - Core framing: open reviewer rounds, central synthesis, isolated worktree execution, supervised validation, and accountable final merge.

- **[C2] Plan repository and install-path migration**
  - Decide whether to rename the GitHub repo from `multi-agent-orchestrator-skill` to `opencabinet` or `opencabinet-skill`.
  - Prefer `opencabinet` if the project is intended to become a broader runtime/brand, or `opencabinet-skill` if it should stay clearly scoped as an agent skill.
  - Update `origin` after the GitHub rename with `git remote set-url origin https://github.com/hyw007726/<new-repo-name>.git`.
  - Preserve compatibility notes for users who installed the old repo URL; GitHub redirects usually help, but docs and installers should move to the canonical new URL.

- **[C2] Rename skill metadata and docs carefully**
  - Update `SKILL.md` frontmatter name/description once the new name is final.
  - Update README title, install examples, manual-use examples, and common command paths.
  - Update `agents/openai.yaml`, `GEMINI.md`, `gemini-extension.json`, `commands/multi-agent-orchestrator.toml`, and `skills/multi-agent-orchestrator/` references.
  - Consider keeping a compatibility alias or wrapper command for `multi-agent-orchestrator` so existing user prompts still trigger the skill.

- **[C2] Decide local folder rename strategy**
  - Renaming the local project folder is mechanically easy, but installed skill paths and docs may still point at the old name.
  - Prefer renaming the repo/folder only after docs, installer, skill aliases, and command wrappers are updated.
  - If installed under Codex, plan migration from `~/.codex/skills/multi-agent-orchestrator` to `~/.codex/skills/opencabinet` while preserving an alias or symlink if needed.

- **[C2] Update installer and compatibility behavior**
  - Update `install-codex.sh` to install into the new canonical skill directory.
  - Optionally detect an old `multi-agent-orchestrator` install and either migrate it or print a clear upgrade message.
  - Ensure examples that use absolute paths still work after the rename.

- **[C1] Run a reference sweep after rename**
  - Use `rg "multi-agent-orchestrator|multi-agent-orchestrator-skill|Multi-Agent Orchestrator"` to find stale references.
  - Update tests that assert names, paths, commands, or generated docs.
  - Run the full test suite after the rename.

## Per-Run Cost Tracking

- **[C2] Add per-run cost tracking**
  - Write estimated token and cost records to `coord/costs.jsonl`.
  - Track at least `run_id`, `agent`, `cli`, `model`, estimated input/output tokens, cache status, ceiling cost, observed cost, and reconciliation status.
  - Quote using uncached input pricing by default; treat cache discounts, batching, and cheaper worker models as margin until observed billing data is available.
  - Support provider-specific usage fields when available, including cache creation tokens, cache read tokens, reasoning tokens, tool calls, and runtime/container fees.


Decide later if it's better to add a frontend UI dashboard than a teriminal board, in the UI dashboard we can also let users ping the model that is supposed to be working