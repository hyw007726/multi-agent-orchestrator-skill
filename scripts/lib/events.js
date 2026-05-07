const fs = require("fs");
const path = require("path");

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
  "restart_scheduled",
  "restart_aborted",
  "agent_completed",
  "abort_requested",
  "recovery_tag_created",
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
  if (agent !== undefined) record.agent = agent;
  if (reason !== undefined) record.reason = reason;
  if (pid !== undefined) record.pid = pid;
  if (data !== undefined) record.data = data;

  try {
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Best-effort: never let logging break the loop.
  }
}

module.exports = { appendEvent };
