# Orchestrator Shared State Schemas

## context.json
Written by the orchestrator session in Phase 2. The orchestrator CLI sees this
verbatim (JSON-stringified) on every arbitration call, so this is where you
encode anything the headless background loop won't otherwise know.

```json
{
  "project": "string — one-line project description",
  "chat_context": {
    "preferences": ["string — e.g. 'Use explicit typing'"],
    "architecture": ["string — e.g. 'MVVM pattern', 'Redux for state'"],
    "naming_conventions": ["string — e.g. 'camelCase for variables'"],
    "gotchas": ["string — e.g. 'User is on Node 18, no top-level await'"]
  },
  "execution_topology": {
    "execution_mode": "string — direct | single_worker | parallel | phased",
    "reason": "string — why this topology is the right amount of orchestration",
    "dependency_notes": ["string — shared-foundation, sequencing, or fan-out dependency notes"]
  },
  "requirements": ["string — compact requirement summaries only; durable detail belongs in DECISIONS.md"],
  "constraints": ["string — compact constraint summaries only; durable detail belongs in DECISIONS.md"],
  "created_at": "ISO 8601 timestamp",
  "tasks": {
    "agent-name": {
      "description": "string — what this agent is allowed to build",
      "cli": "string — which worker CLI to spawn (kilo | aider | claude | codex | gemini | opencode); falls back to default_cli when omitted",
      "mode": "string | omitted — kilo-specific mode (code | architect | debug | ask); ignored by other CLIs",
      "read_first": ["string — files or paths this worker should inspect before broad search; prompt-only guidance"],
      "relevant_files": ["string — legacy alias for read_first; prefer read_first in new context files"],
      "allowed_paths": ["string — glob or path the agent may create/edit (e.g. 'scripts/launch-all.js', 'test/**')"],
      "forbidden_paths": ["string — glob or path the agent must NOT touch (e.g. 'SKILL.md', 'package.json')"],
      "validation_command": "string[] | string | null — JSON argv preferred (no shell expansion); shell-string fallback for pipes / && / env; null disables automated validation",
      "timeout_mins": "integer | omitted — overrides default_timeout_mins (liveness)",
      "progress_timeout_mins": "integer | omitted — overrides default_progress_timeout_mins"
    }
  }
}
```

`bootstrap.js` initializes `chat_context` and `tasks` as empty objects (or wraps
a `--chat-context` string as `{ "summary": "<string>" }` for backward compat)
and creates an empty `execution_topology` skeleton; the orchestrator session is
expected to use the `Edit` tool to populate them between Phase 2 and Phase 4.
Keep this file compact: it is serialized into arbitration prompts. Do not paste
full specs, long chat transcripts, file contents, or large diffs into it. Put
durable requirements, architecture, topology rationale, shared API/data
contracts, and file-ownership rules in `coord/DECISIONS.md`.

`execution_topology.execution_mode` is the final topology chosen by the caller:
`direct`, `single_worker`, `parallel`, or `phased`. `direct` means the caller
should handle the task without launching workers. `single_worker` means exactly
one task should be present. `parallel` means worker boundaries are independent.
`phased` means shared foundation work has already been completed and committed,
and the remaining `tasks` are the independent fan-out leaves.

The full per-agent record under `tasks` is the canonical contract — `launch-all.js`
reads it to drive worktree creation, prompt rendering, and the `spawn-agent.js`
invocation, and the orchestrator loop reads `validation_command` / `timeout_mins`
/ `progress_timeout_mins` from the matching `agents.json` row. The top-level
`execution_topology` is also read by `launch-all.js` to catch direct-mode and
single-worker inconsistencies before spawning. Anything else is the orchestrator
session's free-form context (`chat_context`, `requirements`, `constraints`).

## Optional plan reviewer config

`orchestrator.config.js` may opt into Phase 1.5 plan reviews before the final
`coord/context.json` task map is written.

```js
module.exports = {
  reviewers: [
    {
      name: "architecture",          // stable filename-safe reviewer id
      cli: "claude",                 // must have cli_templates.<cli> and cli_health_checks.<cli>
      review_focus: "ownership boundaries and sequencing risks",
      model: "claude-sonnet-4-6",    // optional; appends --model <id> unless model_flag is set
      model_flag: "--model",         // optional
      template_args: ["--flag"],      // optional CLI-specific args appended to the template
      timeout_mins: 10               // optional per-reviewer timeout
    }
  ],
  max_plan_review_iterations: "auto" // or a positive integer
};
```

When no `reviewers` are configured, the normal Phase 1 decomposition flow is
unchanged. The same configured reviewer list is reused for every review
iteration; callers do not configure per-round reviewer lists. Every configured
reviewer CLI must have health-check coverage because `scripts/preflight.js`
checks reviewer CLIs alongside the worker and orchestrator CLIs.

`max_plan_review_iterations: "auto"` means run at least one review iteration
when reviewers exist, then have the main caller explicitly decide after each
reconciliation whether another pass is worthwhile. A positive integer means run
exactly that many iterations. The runner never self-continues indefinitely.

## Plan review artifacts

Plan review artifacts live under `coord/plan-reviews/` and are owned by the
interactive main caller plus `scripts/review-plan.js`. Reviewers are read-only:
their feedback informs the final decomposition but does not directly mutate
`coord/context.json` or `coord/DECISIONS.md`.

Draft plans are versioned:

```json
{
  "project": "string",
  "user_requirements": ["string"],
  "constraints": ["string"],
  "candidate_execution_topology": {
    "execution_mode": "direct | single_worker | parallel | phased",
    "reason": "string",
    "rejected_alternatives": [
      {
        "execution_mode": "direct | single_worker | parallel | phased",
        "reason": "string"
      }
    ],
    "dependency_notes": ["string"],
    "shared_foundation_notes": ["string"],
    "mode_specific_decomposition": ["string"]
  },
  "shared_foundation_assumptions": ["string"],
  "known_risks": ["string"],
  "tasks": {
    "agent-name": {
      "description": "string",
      "allowed_paths": ["string"],
      "forbidden_paths": ["string"],
      "read_first": ["string"],
      "validation_command": "string[] | string | null",
      "sequencing_notes": ["string"]
    }
  }
}
```

The runner stores each latest draft as
`coord/plan-reviews/draft-plan-v<N>.json`. Review iterations are stored under
`coord/plan-reviews/iteration-<N>/`.

Each reviewer stream is written live to `<reviewer>.md`. When valid JSON can be
extracted and it satisfies the required shape, the parsed response is stored as
`<reviewer>.json`:

```json
{
  "iteration": 1,
  "reviewer": "architecture",
  "summary": "string",
  "execution_mode_issues": ["string"],
  "blockers": ["string"],
  "overlaps": ["string"],
  "missing_foundation_work": ["string"],
  "sequencing_risks": ["string"],
  "validation_gaps": ["string"],
  "suggested_changes": ["string"]
}
```

Invalid JSON or missing required fields is a reviewer failure, not a blocker for
the whole workflow unless every reviewer in the iteration fails. Reviewers
should use `execution_mode_issues` for topology-specific concerns: mode too
heavy, too weak, incorrectly sequenced, `parallel` that should be `phased`,
unnecessary coordination where `single_worker` or `direct` would suffice, or
worker boundaries that are unsafe for the chosen mode.

After each iteration, the main caller writes
`coord/plan-reviews/iteration-<N>/reconciliation.json`:

```json
{
  "iteration": 1,
  "accepted_feedback": [
    {
      "reviewer": "architecture",
      "item": "string",
      "rationale": "string",
      "draft_plan_change": "string"
    }
  ],
  "rejected_feedback": [
    {
      "reviewer": "architecture",
      "item": "string",
      "rationale": "string"
    }
  ],
  "next_iteration": {
    "run": false,
    "rationale": "string"
  }
}
```

Later iterations must receive the updated `draft-plan-v<N>.json` and the prior
`reconciliation.json`; they must not review a stale initial draft. Implementation
workers launch only after the final chosen/configured review iteration has been
reconciled and the final `coord/context.json` task map is written.

## Worker-prompt placeholder grammar

`launch-all.js` machine-substitutes the placeholders in
`references/worker-prompt-template.md` from the per-agent record above plus a
small set of values it derives at spawn time. Every placeholder is matched
verbatim (`{NAME}`) and replaced once.

| Placeholder              | Source                                                          |
|--------------------------|-----------------------------------------------------------------|
| `{ASSIGNED_TASK}`        | `tasks[<agent>].description`                                    |
| `{PROJECT_DESCRIPTION}`  | `project` (top-level)                                           |
| `{AGENT_NAME}`           | the key under `tasks`                                           |
| `{WORKTREE_PATH}`        | derived: `.kilocode/worktrees/<agent>` for kilo, else `.agents/worktrees/<agent>` |
| `{ALLOWED_PATHS_LIST}`   | comma-joined `tasks[<agent>].allowed_paths`                     |
| `{FORBIDDEN_PATHS_LIST}` | comma-joined `tasks[<agent>].forbidden_paths`                   |
| `{READ_FIRST_LIST}`      | comma-joined `tasks[<agent>].read_first`; `relevant_files` is accepted as a legacy alias |
| `{WORKER_CONCISION_PROMPT}` | built-in concise response-style instructions                 |

Any placeholder whose source field is missing is replaced with the literal
string `"(unspecified)"` so the worker still receives a syntactically intact
prompt and can ask via `coord/requests/` for clarification.

## DECISIONS.md

Human-curated contract for durable requirements, architecture, API, data-model,
file ownership, and structural decisions. The starter/orchestrator session
updates this file when an approved runtime decision should become shared project
policy. The background loop includes this file in arbitration prompts but does
not automatically rewrite it.

## decisions.json

Bounded recent window of approved request resolutions. The orchestrator loop
uses this file in arbitration prompts and the dashboard reads it for recent
decision display. It is intentionally capped to the latest 30 entries; use
`decisions.jsonl` for full audit history.

```json
[
  {
    "request_id": "string",
    "decision": "string — what was decided",
    "reason": "string — why",
    "resolved_at": "ISO 8601 timestamp"
  }
]
```

## decisions.jsonl

Append-only audit log of every approved request resolution, one JSON object per
line. This file is not pruned and is the place to look for older approved
decisions that have fallen out of `decisions.json`.

```json
{"request_id":"string","decision":"string — what was decided","reason":"string — why","resolved_at":"ISO 8601 timestamp"}
```

## requests/
Worker-owned staging directory for new requests. A worker MUST write a single
JSON object to a unique `.tmp` file in this directory, then atomically rename it
to `.json`. Workers must not append directly to `requests.jsonl`; the loop is
the only writer that consolidates staged files into that log and updates request
statuses.

## requests.jsonl
Orchestrator-owned JSON Lines log, one JSON object per line:
```json
{"request_id": "string — unique ID", "agent": "string — name of agent", "type": "question | change | conflict | review_request", "priority": "low | medium | high", "content": "string — detailed request", "status": "pending | resolved | rejected", "created_at": "ISO 8601 timestamp"}
```

## agents.json
Written by `spawn-agent.js` and mutated by `orchestrator-loop.js`. The full
shape — every field the loop actually depends on — is:

```json
{
  "agent-frontend": {
    "task": "string — current task description (rewritten on every restart with the new instruction)",
    "status": "running | completed | terminated | errored | exited",
    "worktree": "string — absolute path to the agent's git worktree (`.kilocode/worktrees/<name>` for kilo, `.agents/worktrees/<name>` otherwise)",
    "cli": "string — which worker CLI was used (kilo | aider | claude | codex | gemini | opencode); the loop reads this to pick the respawn template and to validate the PID's cmdline before signalling",
    "template_mode": "string — argv | shell | builtin; records how the CLI template was executed for debugging shell/quoting behavior",
    "kilo_mode": "string — kilo-specific mode (code | architect | debug | ask); ignored by non-kilo CLIs but persisted for round-tripping through respawn",
    "pid": "integer — the process ID of the spawned worker CLI; on POSIX this is also the detached process group id the loop signals during stops/restarts",
    "started_at": "ISO 8601 timestamp",
    "last_heartbeat": "ISO 8601 timestamp",
    "validate_cmd": "string | string[] | null — JSON argv array (preferred, runs with shell:false) or shell-string fallback; null disables validation",
    "timeout_mins": "integer | null — liveness threshold (no log output); falls back to default_timeout_mins from orchestrator.config.js",
    "progress_timeout_mins": "integer | null — progress threshold (no code change while logs flow); falls back to default_progress_timeout_mins",
    "restart_count": "integer — bumped on every respawn (validation failure, AI-Review course-correction, explicit soft/hard restart); once it exceeds default_max_restarts the loop marks the agent `errored` instead of respawning",
    "base_ref": "string — the Git ref (branch or tag) this agent's worktree was branched from; used for diff computation (defaults to 'main' if not recorded)",
    "recovery_tag": "string | omitted — Git tag name (e.g. `recovery/agent-frontend/2025-01-01T00-00-00-000Z`) holding pre-hard-restart state; set by the loop when a hard restart successfully creates a recovery tag",
    "exit_log_tail": "string | null — last 50 lines of worker logs captured when the process vanished without a review_request"
  }
}
```
