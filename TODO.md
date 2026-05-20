# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)


## Medium (UX gaps, missing safety nets)

- [x] **[C2] Add `--json` mode to scripts the LLM consumes**: emit a stable schema from `preflight.js`, `validate-context.js`, `launch-all.js`, and a new `status.js` so the caller LLM can branch on structured fields instead of string-matching stdout. Human-readable output stays the default.
- [x] **[C1] Add `scripts/status.js`**: read `coord/agents.json`, `coord/events.jsonl`, and any `coord/orchestrator-stalled.flag`, then emit `{ loop_state, agents: [{ name, state, last_event_seq, blocker? }] }`. Supports both human text and `--json`. Becomes the canonical "what's happening right now" probe so SKILL.md can stop pointing at multiple files.
- [x] **[C1] Slim SKILL.md by collapsing alternative paths**: for each phase, name exactly one canonical command (`prepare-run.js`, `launch-all.js`, `status.js`). Move "or you could also…" variants to a Power-user appendix. Goal is to reduce context bloat without losing any capability.
- [x] **[C1] Trim repeated rationale prose in SKILL.md**: drop duplicated "IMPORTANT/CRITICAL/Action:" callouts where the same point is restated; the runtime shape is fine, the prose is the bloat.