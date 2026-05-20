const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { updateJSON, readJSON } = require("./locking");
const { gitStdout } = require("./git-ops");
const { tailLines } = require("./log-tail");

const HEARTBEAT_GRACE_PHASES = new Set(["starting", "reading", "planning", "testing", "running_tests", "building", "installing", "debugging"]);

function hasPendingProgressTimeoutRequest(requests, agentName) {
  return requests.some((request) =>
    request &&
    request.agent === agentName &&
    request.type === "progress_timeout" &&
    request.status === "pending"
  );
}

function buildProgressTimeoutRequest({ agentName, agent, progressMins, logFile, diffSnapshot, heartbeat, paths, allRequests, parsedConfig }) {
  const task = readTaskContext(paths.context, agentName);
  const history = progressTimeoutHistory(allRequests, agentName, agent.progress_timeout_reset_at);
  const escalation = buildProgressEscalation({
    previousProgressTimeouts: history.previousCount,
    restartCount: agent.restart_count || 0,
    maxRestarts: parsedConfig.default_max_restarts,
    hasRecoveryTag: Boolean(agent.recovery_tag),
    progressMins,
  });
  const tailLines = readTail(logFile, 50).trim();
  const validateCmd = agent.validate_cmd === undefined ? null : agent.validate_cmd;

  const content = [
    `The orchestrator loop detected a progress timeout for ${agentName}.`,
    `No git-visible changes were observed for ${progressMins} minute(s) while the process remained alive.`,
    `Escalation level: ${escalation.level}`,
    `Progress timeout count for this agent: ${history.timeoutCount}`,
    `Current restart_count: ${agent.restart_count || 0}; restart budget remaining: ${escalation.restartsRemaining}`,
    `Suggested action: ${escalation.suggestedAction}`,
    `Suggested instruction:\n${escalation.instruction}`,
    `Escalation rationale:\n${escalation.rationale}`,
    `Current agent task:\n${agent.task || task?.description || "(unknown)"}`,
    `Original task description:\n${task?.description || "(not available)"}`,
    `Allowed paths: ${formatList(task?.allowed_paths)}`,
    `Forbidden paths: ${formatList(task?.forbidden_paths)}`,
    `Validation command: ${JSON.stringify(validateCmd)}`,
    `Progress heartbeat:\n${formatHeartbeatForRequest(heartbeat)}`,
    `Current diff/progress snapshot:\n${diffSnapshot.trim() || "(no git-visible changes)"}`,
    `Last 50 log lines:\n${tailLines || "(no log lines captured)"}`,
    "Decide whether to follow the suggested action, wait, choose another restart mode, or reject for manual inspection.",
  ].join("\n\n");

  return {
    request_id: `progress-timeout-${agentName}-${Date.now()}`,
    agent: agentName,
    type: "progress_timeout",
    priority: "high",
    content,
    status: "pending",
    created_at: new Date().toISOString(),
    source: "orchestrator-loop",
    escalation_level: escalation.level,
    previous_progress_timeouts: history.previousCount,
    progress_timeout_count: history.timeoutCount,
    restart_count: agent.restart_count || 0,
    restarts_remaining: escalation.restartsRemaining,
    suggested_action: escalation.suggestedAction,
    suggested_instruction: escalation.instruction,
  };
}

// Counts progress_timeout requests filed against this agent since the last
// "milestone" — a real code change, a wait-style arbitration resolution, or a
// resume-agent.js run. Without a reset_at we fall back to counting the whole
// history, which keeps fresh loop boots responsive to a backlog of prior
// stalls (and preserves the legacy behavior for agents that have never made
// progress).
function progressTimeoutHistory(requests, agentName, resetAt) {
  const resetMs = parseIsoMs(resetAt);
  const previousCount = requests.filter((request) => {
    if (!request || request.agent !== agentName || request.type !== "progress_timeout") return false;
    if (!Number.isFinite(resetMs)) return true;
    const createdMs = parseIsoMs(request.created_at);
    return Number.isFinite(createdMs) && createdMs >= resetMs;
  }).length;
  return { previousCount, timeoutCount: previousCount + 1 };
}

function parseIsoMs(value) {
  if (typeof value !== "string" || value.trim() === "") return NaN;
  return Date.parse(value);
}

// Shared — called from the per-cycle progress tracker and from processApprovals
// (wait-style resolutions). Updates the agent's progress_timeout_reset_at
// timestamp so progressTimeoutHistory only counts new stalls when the agent
// next stalls. No-op if the agent has vanished from agents.json.
function stampProgressMilestone(paths, agentName, kind) {
  const stamp = new Date().toISOString();
  updateJSON(paths.agents, (agents) => {
    const agent = agents[agentName];
    if (!agent) return;
    agent.progress_timeout_reset_at = stamp;
    agent.progress_timeout_reset_kind = kind;
  });
  return stamp;
}

function buildProgressEscalation({ previousProgressTimeouts, restartCount, maxRestarts, hasRecoveryTag, progressMins }) {
  const timeoutCount = previousProgressTimeouts + 1;
  const restartsRemaining = Math.max((maxRestarts || 0) - restartCount, 0);
  const baseInstruction = buildDeterministicProgressInstruction(progressMins);

  if (restartsRemaining === 0) {
    return {
      level: "restart_budget_exhausted",
      suggestedAction: "manual_inspection",
      instruction: baseInstruction,
      rationale: "The agent has no restart budget remaining. Prefer manual inspection or allow the restart cap to mark the agent errored instead of scheduling another respawn.",
      restartsRemaining,
    };
  }

  if (timeoutCount === 1) {
    return {
      level: "first_timeout",
      suggestedAction: "soft_restart",
      instruction: baseInstruction,
      rationale: "First no-progress timeout. Prefer a deterministic soft restart unless heartbeat or logs show the agent should be allowed to continue.",
      restartsRemaining,
    };
  }

  if (timeoutCount === 2) {
    return {
      level: "repeated_timeout",
      suggestedAction: "soft_restart",
      instruction: `This is your second no-progress timeout. ${baseInstruction}`,
      rationale: "The agent has already timed out once without git-visible progress. Prefer a stronger soft restart instruction unless the heartbeat clearly explains expected non-editing work.",
      restartsRemaining,
    };
  }

  if (hasRecoveryTag) {
    return {
      level: "manual_inspection_after_recovery",
      suggestedAction: "manual_inspection",
      instruction: `Repeated progress timeouts continue after a prior hard-restart recovery tag. ${baseInstruction}`,
      rationale: "A recovery tag already exists, so another destructive reset is less likely to help. Prefer manual inspection unless the current worktree is clearly disposable.",
      restartsRemaining,
    };
  }

  return {
    level: "hard_restart_candidate",
    suggestedAction: "hard_restart",
    instruction: `Repeated progress timeouts indicate the current worktree may be trapped in an unproductive state. Restart from a clean worktree, then ${baseInstruction.charAt(0).toLowerCase()}${baseInstruction.slice(1)}`,
    rationale: "This is the third or later progress timeout and no recovery tag is recorded yet. A hard restart is now reasonable, while preserving current work in a recovery tag.",
    restartsRemaining,
  };
}

function buildDeterministicProgressInstruction(progressMins) {
  return [
    `You have produced no git-visible changes for ${progressMins} minute(s).`,
    "Re-read coord/DECISIONS.md, coord/CALLER_CONTEXT.md, and coord/context.json, run git status, and inspect your assigned read_first files.",
    "Then either make a concrete code/test/docs change within your allowed paths, or file a high-priority request explaining the exact blocker with relevant logs and file context.",
  ].join(" ");
}

function readProgressHeartbeat(progressDir, agentName) {
  const filePath = path.join(progressDir, `${agentName}.json`);
  if (!fs.existsSync(filePath)) {
    return { exists: false, path: filePath, mtimeMs: 0 };
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { exists: true, path: filePath, valid: false, error: err.message, mtimeMs: 0 };
  }

  const base = {
    exists: true,
    path: filePath,
    mtimeMs: stat.mtimeMs,
    mtime: new Date(stat.mtimeMs).toISOString(),
    ageMs: Math.max(0, Date.now() - stat.mtimeMs),
  };

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const phase = normalizeHeartbeatPhase(data.phase || data.status);
    return {
      ...base,
      valid: true,
      phase,
      data: limitHeartbeatData(data),
    };
  } catch (err) {
    return { ...base, valid: false, error: err.message };
  }
}

function heartbeatChanged(heartbeat, tracker) {
  return heartbeat.exists && heartbeat.mtimeMs > (tracker.last_heartbeat_mtime || 0);
}

function shouldGrantHeartbeatGrace(heartbeat, tracker) {
  if (!heartbeat.valid || !heartbeat.phase) return false;
  if (!HEARTBEAT_GRACE_PHASES.has(heartbeat.phase)) return false;
  return (tracker.heartbeat_grace_count || 0) < 1;
}

function normalizeHeartbeatPhase(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function limitHeartbeatData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const allowed = ["agent", "phase", "status", "summary", "last_action", "blocker", "updated_at"];
  const out = {};
  for (const key of allowed) {
    if (data[key] === undefined) continue;
    const value = data[key];
    out[key] = typeof value === "string" ? value.slice(0, 1000) : value;
  }
  return out;
}

function formatHeartbeatForRequest(heartbeat) {
  if (!heartbeat || !heartbeat.exists) return "(none)";
  const base = {
    file_mtime: heartbeat.mtime || null,
    age_seconds: heartbeat.ageMs === undefined ? null : Math.round(heartbeat.ageMs / 1000),
  };
  if (!heartbeat.valid) {
    return JSON.stringify({ ...base, valid: false, error: heartbeat.error || "invalid heartbeat" }, null, 2);
  }
  return JSON.stringify({
    ...base,
    valid: true,
    phase: heartbeat.phase || "",
    data: heartbeat.data || {},
  }, null, 2);
}

function formatList(value) {
  if (Array.isArray(value) && value.length > 0) return value.join(", ");
  return "(unspecified)";
}

function readDiffSnapshot(worktree) {
  if (!fs.existsSync(worktree)) return "";
  try {
    const unstaged = gitStdout(worktree, ["diff", "--stat"]);
    const staged = gitStdout(worktree, ["diff", "--staged", "--stat"]);
    const commits = gitStdout(worktree, ["log", "-n", "5", "--oneline"]);
    const untracked = gitStdout(worktree, ["ls-files", "--others", "--exclude-standard"]);
    return `${unstaged}\n${staged}\n${commits}\n${untracked}`;
  } catch { return ""; }
}

// Cheap per-tick change-detection: one git invocation, hashed. The porcelain v2
// `--branch` output captures both the working-tree state (modified/staged/
// untracked, fully enumerated with `-uall`) and the current HEAD oid (via the
// `# branch.oid <sha>` header), so a worker either rewriting files or landing
// a commit changes the hash. Only the equality is meaningful; the full
// snapshot for progress-timeout-request payloads still goes through
// readDiffSnapshot when it's actually needed.
function readDiffHash(worktree) {
  if (!fs.existsSync(worktree)) return "";
  try {
    const status = gitStdout(worktree, ["status", "--porcelain=v2", "--branch", "-uall"]);
    return crypto.createHash("sha1").update(status).digest("hex");
  } catch { return ""; }
}

function readTaskContext(contextPath, agentName) {
  try {
    const context = readJSON(contextPath);
    return context.tasks?.[agentName] || null;
  } catch {
    return null;
  }
}

// Thin wrapper around lib/log-tail.tailLines. Workers emit stream-json that
// can balloon to hundreds of MB on long runs; we never want to slurp the whole
// file just to grab the trailing 50 lines.
function readTail(filePath, lines) {
  return tailLines(filePath, lines);
}

module.exports = {
  HEARTBEAT_GRACE_PHASES,
  hasPendingProgressTimeoutRequest,
  buildProgressTimeoutRequest,
  progressTimeoutHistory,
  parseIsoMs,
  stampProgressMilestone,
  buildProgressEscalation,
  buildDeterministicProgressInstruction,
  readProgressHeartbeat,
  heartbeatChanged,
  shouldGrantHeartbeatGrace,
  normalizeHeartbeatPhase,
  limitHeartbeatData,
  formatHeartbeatForRequest,
  formatList,
  readDiffSnapshot,
  readDiffHash,
};
