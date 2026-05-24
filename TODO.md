# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)

_(none)_

## Medium (UX gaps, missing safety nets)

- **[C2] Re-sync the installed Codex skill copy.** `~/.codex/skills/multi-agent-orchestrator/SKILL.md` is divergent: still documents the retired `prompt_text` arg shape, lists Aider as a supported CLI, omits `status.js`, omits the `foundation` block, omits `needs_attention`, and presents Phase 1.5 inline rather than as an appendix. Fix `install-codex.sh` (and any equivalent Gemini install path) so install copies the canonical SKILL.md from the repo rather than shipping a snapshot.

- **[C2] Phase 5 has no automation.** Diff, merge, conflict detection, worktree removal are all manual. A `scripts/integrate-agent.js` that runs `git diff <base_ref>...<agent>` + a conflict pre-check + the standard merge/worktree-remove sequence would close the loop. Keep it opt-in — Phase 5 must remain human-gated.
