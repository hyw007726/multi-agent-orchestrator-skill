# Orchestrator Shared State Schemas

## context.json
```json
{
  "project": "string — one-line project description",
  "chat_context": "string — compacted summary of original conversation context and user preferences",
  "requirements": ["string — each requirement"],
  "constraints": ["string — each constraint"],
  "created_at": "ISO 8601 timestamp",
  "tasks": {
    "agent-name": "string — task description (added during decomposition)"
  }
}
```

## decisions.json
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

## requests.jsonl
(JSON Lines format - one JSON object per line)
```json
{"request_id": "string — unique ID", "agent": "string — name of agent", "type": "question | change | conflict | review_request", "priority": "low | medium | high", "content": "string — detailed request", "status": "pending | resolved | rejected", "created_at": "ISO 8601 timestamp"}
```

## agents.json
Written by `spawn-agent.ts` and mutated by `orchestrator-loop.ts`. The full
shape — every field the loop actually depends on — is:

```json
{
  "agent-frontend": {
    "task": "string — current task description (rewritten on every restart with the new instruction)",
    "status": "running | completed | terminated | errored",
    "worktree": "string — absolute path to the agent's git worktree (`.kilocode/worktrees/<name>` for kilo, `.agents/worktrees/<name>` otherwise)",
    "cli": "string — which worker CLI was used (kilo | aider | claude | codex | gemini | opencode); the loop reads this to pick the respawn template and to validate the PID's cmdline before signalling",
    "kilo_mode": "string — kilo-specific mode (code | architect | debug | ask); ignored by non-kilo CLIs but persisted for round-tripping through respawn",
    "pid": "integer — the process ID of the spawned worker CLI",
    "started_at": "ISO 8601 timestamp",
    "last_heartbeat": "ISO 8601 timestamp",
    "validate_cmd": "string | string[] | null — JSON argv array (preferred, runs with shell:false) or shell-string fallback; null disables validation",
    "timeout_mins": "integer | null — liveness threshold (no log output); falls back to default_timeout_mins from orchestrator.config.yml",
    "progress_timeout_mins": "integer | null — progress threshold (no code change while logs flow); falls back to default_progress_timeout_mins",
    "max_iterations": "integer | null — cap on tool loops",
    "restart_count": "integer — bumped on every respawn (validation failure, AI-Review course-correction, explicit soft/hard restart); once it exceeds default_max_restarts the loop marks the agent `errored` instead of respawning"
  }
}
```
