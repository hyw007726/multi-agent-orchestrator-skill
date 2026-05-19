const path = require("path");
const { appendJSONL, readCurrentRunId } = require("./locking");

/**
 * Lightweight structured event logger.
 *
 * Appends best-effort JSONL lines to `coord/events.jsonl`.  Failures are silently
 * ignored - the orchestrator loop must never break on a logging error.
 *
 * Events are keyed by timestamp so they sort naturally when concatenated across
 * restarts.  Every event carries an `event` type string and can carry optional
 * `agent`, `reason`, `pid`, and free-form `data`.
 */

const VALID_EVENTS = new Set([
  "agent_spawned",
  "signal_sent",
  "process_exited",
  "validation_failed",
  "progress_timeout_requested",
  "heartbeat_grace_used",
  "restart_scheduled",
  "restart_aborted",
  "agent_completed",
  "abort_requested",
  "recovery_tag_created",
  "agent_parked",
  "agent_resumed",
  "arbitration_action_dropped",
]);

// Public API

/**
 * Append one structured event to `coord/events.jsonl`.
 *
 * @param {string}   coordDir - Path to the coordination directory.
 * @param {string}   event   - One of the known event type strings.
 * @param {object}  [opts={}]
 * @param {string}  [opts.agent]   - Agent name.
 * @param {string}  [opts.reason]  - Human-readable reason.
 * @param {number}  [opts.pid]     - Relevant process ID.
 * @param {object}  [opts.data]    - Extra structured data.
 */
function appendEvent(coordDir, event, { agent, reason, pid, data } = {}) {
  if (!VALID_EVENTS.has(event)) return; // silently drop unknown events
  const filePath = path.join(coordDir, "events.jsonl");
  const record = {
    timestamp: new Date().toISOString(),
    event,
  };
  const runId = cachedRunId(coordDir);
  if (runId) record.run_id = runId;
  if (agent !== undefined) record.agent = agent;
  if (reason !== undefined) record.reason = reason;
  if (pid !== undefined) record.pid = pid;
  if (data !== undefined) record.data = data;

  try {
    // Route through the locked append so records over PIPE_BUF can't interleave
    // and corrupt events.jsonl during restart bursts.
    appendJSONL(filePath, [record]);
  } catch {
    // Best-effort: never let logging break the loop.
  }
}

// Single-use helper — used only by appendEvent above.
// Caches the run_id per coordDir for the lifetime of this process. The
// orchestrator-loop writes current_run.json once at startup; subprocesses
// (spawn-agent, resume-agent) read it once and reuse it. Cache miss ⇒ re-read,
// so a subprocess spawned after the file lands still picks up the value.
const runIdCache = new Map();
function cachedRunId(coordDir) {
  if (!coordDir) return null;
  if (runIdCache.has(coordDir)) return runIdCache.get(coordDir);
  const runId = readCurrentRunId(coordDir);
  if (runId) runIdCache.set(coordDir, runId);
  return runId;
}

module.exports = { appendEvent };
