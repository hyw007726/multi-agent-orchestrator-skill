# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)

- **[C1] SKILL.md still says liveness timeout / restart-cap "marks errored".** In code both paths call `parkAgentForAttention()` → `needs_attention` (`scripts/orchestrator-loop.js:209`, `scripts/lib/actions.js:341`). Operators following only SKILL.md will misread amber `ATTENTION:` rows as hard failures and skip `resume-agent.js`. Rewrite the "Progress monitoring" and "Restart cap" paragraphs to describe `needs_attention` as the terminal state, and add a Phase-5 note that any parked agent must be resumed or abandoned before merge.

- **[C1] Phase 5 merge instructions hard-code `main`.** `git diff main...<agent-name>` ignores `agent.base_ref`, which the runtime already stores and which `ownership.js` / `arbitration.js` already honor. Switch the SKILL.md snippet to `git diff <base_ref>...<agent-name>` (read from `coord/agents.json` or `coord/context.json`) so phased/foundation runs don't silently diff against the wrong base.

- **[C1] Misleading "errored" log line and dead status.** `scripts/lib/actions.js:405` logs `"Marking errored, not respawning"` but the prior block parks for attention. `STATUS.ERRORED` exists in `scripts/lib/status.js` and is referenced by `orchestrator-loop.js:365`, `finalize.js:77,136`, `status.js:212`, `dashboard.js:132` — but nothing currently sets it. Either (a) delete `STATUS.ERRORED` and the dead branches and fix the log line, or (b) reintroduce a real `errored` terminal status distinct from `needs_attention` for unrecoverable failures, and document the distinction.

## Medium (UX gaps, missing safety nets)

- **[C1] Link operator docs from SKILL.md.** `docs/resolving-needs-attention.md` and `docs/manual-intervention-policy.md` exist but are unreferenced. Add a "Recovering parked agents" subsection under Phase 4 monitoring that names `scripts/resume-agent.js` and links both docs.

- **[C1] Document the soft-enforcement of `allowed_paths` / `forbidden_paths`.** Ownership is checked at `review_request` / completion and the first violation triggers `soft_restart`, not park (`scripts/lib/ownership.js`, `scripts/lib/actions.js:227-251`). SKILL.md implies hard boundaries. Add a one-paragraph caveat near the path-mapping bullets and link `docs/manual-intervention-policy.md`.

- **[C1] Document the monitoring split.** State explicitly in SKILL.md that the TUI dashboard is a glance view and `scripts/status.js --json` is the canonical probe. The dashboard lacks `loop_state`, event sequence, structured `next_steps`, and the `review-summary.txt` pointer. If the gap is worth closing instead, extend `dashboard.js` to surface those fields.

- **[C1] Add SKILL.md caveats for known platform / safety limits.** (a) Windows: symlinked worktrees + POSIX process-group signalling degrade — already `[C2]` on Roadmap, but the skill should warn callers. (b) Security: workers run with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo` / `--auto`; flag this as "trusted repos only, no secrets in worktrees". (c) Arbitration stall playbook: when `coord/orchestrator-stalled.flag` is raised, fix the CLI rather than hand-editing `requests.jsonl` / `decisions.jsonl`.

- **[C1] Drop dead `errored` from the loop's all-done gate.** `scripts/orchestrator-loop.js:365` still treats `"errored"` as a terminal status when computing whether to exit. Harmless today (nothing sets it) but confuses readers and tests that try to simulate the path. Remove if option (a) above is chosen; keep and wire up if option (b) is chosen.

- **[C2] Re-sync the installed Codex skill copy.** `~/.codex/skills/multi-agent-orchestrator/SKILL.md` is divergent: still documents the retired `prompt_text` arg shape, lists Aider as a supported CLI, omits `status.js`, omits the `foundation` block, omits `needs_attention`, and presents Phase 1.5 inline rather than as an appendix. Fix `install-codex.sh` (and any equivalent Gemini install path) so install copies the canonical SKILL.md from the repo rather than shipping a snapshot.

- **[C2] Phase 5 has no automation.** Diff, merge, conflict detection, worktree removal are all manual. A `scripts/integrate-agent.js` that runs `git diff <base_ref>...<agent>` + a conflict pre-check + the standard merge/worktree-remove sequence would close the loop. Keep it opt-in — Phase 5 must remain human-gated.

