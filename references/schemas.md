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
  "requirements": ["string — each requirement"],
  "constraints": ["string — each constraint"],
  "created_at": "ISO 8601 timestamp",
  "tasks": {
    "agent-name": {
      "description": "string — what this agent is allowed to build",
      "cli": "string — which worker CLI to spawn (kilo | aider | claude | codex | gemini | opencode); falls back to default_cli when omitted",
      "mode": "string | omitted — kilo-specific mode (code | architect | debug | ask); ignored by other CLIs",
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
a `--chat-context` string as `{ "summary": "<string>" }` for backward compat);
the orchestrator session is expected to use the `Edit` tool to populate them
between Phase 2 and Phase 4. The keys under `chat_context` are advisory — the
loop only serializes the whole object into the arbitration prompt.

The full per-agent record under `tasks` is the canonical contract — `launch-all.js`
reads it to drive worktree creation, prompt rendering, and the `spawn-agent.js`
invocation, and the orchestrator loop reads `validation_command` / `timeout_mins`
/ `progress_timeout_mins` from the matching `agents.json` row. Anything not in
this shape is the orchestrator session's free-form context (`chat_context`,
`requirements`, `constraints`).

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
| `{WORKER_CONCISION_PROMPT}` | built-in concise response-style instructions                 |

Any placeholder whose source field is missing is replaced with the literal
string `"(unspecified)"` so the worker still receives a syntactically intact
prompt and can ask via `coord/requests/` for clarification.

## DECISIONS.md

Human-curated contract for durable architecture, API, data-model, and
file-ownership decisions. The starter/orchestrator session updates this file
when an approved runtime decision should become shared project policy. The
background loop does not automatically rewrite it.

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
