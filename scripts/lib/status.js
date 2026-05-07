/**
 * Agent status constants and transition helper.
 *
 * Keeps the permitted status set in one place so the orchestrator loop never
 * mutates `agents[name].status` via ad-hoc writes. Every transition is logged
 * through the existing orchestrator log (which the caller must pass in).
 */

const STATUS = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  TERMINATED: "terminated",
  EXITED: "exited",
  ERRORED: "errored",
});

const ALLOWED = new Set(Object.values(STATUS));

/**
 * Transition an agent object to a new status.
 *
 * Returns the agent object (mutated in place) so callers can chain additional
 * updates inside the same `updateJSON` callback.
 *
 * @param {object}   agent      - The agent entry object (from agents.json).
 * @param {string}   name       - The agent's key name.
 * @param {string}   nextStatus - One of the STATUS constants.
 * @param {string}   reason     - Human-readable reason for the transition.
 * @param {function} log        - Orchestrator `log` function for audit trail.
 * @returns {object} The agent object.
 */
function transitionAgentStatus(agent, name, nextStatus, reason, log) {
  if (!ALLOWED.has(nextStatus)) {
    throw new Error(`Invalid agent status: ${nextStatus}`);
  }
  const from = agent.status || "(none)";
  agent.status = nextStatus;
  agent.last_heartbeat = new Date().toISOString();
  const timestamp = new Date().toISOString();
  log(`[${timestamp}] Agent ${name} status: ${from} -> ${nextStatus} (${reason})`);
  return agent;
}

module.exports = { STATUS, transitionAgentStatus };
