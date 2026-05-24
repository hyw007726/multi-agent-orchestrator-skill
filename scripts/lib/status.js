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
  // Parked pending human review: the worktree is intact and a human can resume
  // the work via resume-agent.js.
  NEEDS_ATTENTION: "needs_attention",
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

/**
 * Park an agent for human review.
 *
 * Thin wrapper over {@link transitionAgentStatus} so the `needs_attention`
 * flip and the `attention_*` / `next_steps` fields are written in the same
 * `updateJSON` callback — a parked record is never observed without its reason
 * or its recovery guidance.
 *
 * @param {object}   agent     - The agent entry object (from agents.json).
 * @param {string}   name      - The agent's key name.
 * @param {string}   reason    - Why the agent is parked (also the audit reason).
 * @param {function} log       - Orchestrator `log` function for audit trail.
 * @param {object}   [fields]  - { nextSteps?: string } human recovery guidance.
 * @returns {object} The agent object.
 */
function parkAgentForAttention(agent, name, reason, log, fields = {}) {
  transitionAgentStatus(agent, name, STATUS.NEEDS_ATTENTION, reason, log);
  agent.attention_reason = reason;
  agent.attention_at = new Date().toISOString();
  if (fields.nextSteps !== undefined) {
    agent.next_steps = fields.nextSteps;
  }
  return agent;
}

// Shared — used by the liveness-timeout, restart-budget-exhausted,
// hard-restart-recovery-failed, and respawn-failed park sites in
// scripts/orchestrator-loop.js. Site-keyed so the human recovery guidance
// written into `next_steps` is owned by the status domain and stays decoupled
// from buildProgressEscalation, which is structurally about progress timeouts.
// All four are Class B "no cheap recovery" failures
// (docs/manual-intervention-policy.md).
const PARK_RATIONALES = Object.freeze({
  liveness_timeout:
    "The worker produced no log output within its liveness window and was " +
    "killed. This usually means it is wedged, or its CLI/auth/model setup is " +
    "broken; a blind restart tends to re-wedge. Inspect the agent log and the " +
    "preserved worktree, fix the underlying CLI/auth/environment issue, then " +
    "resume or restart the worker manually.",
  restart_budget_exhausted:
    "The agent has no restart budget remaining: the cheap recovery path " +
    "(soft/hard restart) has already been spent the full restart allowance, " +
    "so another automatic restart would just loop. Review the agent log and " +
    "worktree, decide whether the work is salvageable, and either resume it " +
    "manually or abandon the branch.",
  hard_restart_recovery_failed:
    "A hard restart was attempted but the recovery/reset primitive itself " +
    "failed, so there is no further automatic fallback. Inspect the worktree " +
    "state and the recovery error in the log, repair the worktree by hand if " +
    "needed, then resume or restart the worker manually.",
  respawn_failed:
    "The orchestrator killed the previous worker process and tried to relaunch " +
    "it, but spawn-agent.js failed before the replacement could be registered " +
    "(missing CLI binary, EAGAIN, disk pressure, transient OS error, etc.). " +
    "This is an infrastructure problem rather than a worker-code issue, so the " +
    "restart budget was refunded. Inspect the orchestrator log, fix the " +
    "underlying spawn issue (CLI installation, env vars, disk space, fd " +
    "limits), then resume or restart the worker manually.",
});

/**
 * Return the human recovery guidance (`next_steps`) for a park site.
 *
 * @param {string} site - One of the {@link PARK_RATIONALES} keys.
 * @returns {string} The rationale paragraph for that site.
 */
function parkRationale(site) {
  const rationale = PARK_RATIONALES[site];
  if (rationale === undefined) {
    throw new Error(`Unknown park site: ${site}`);
  }
  return rationale;
}

module.exports = { STATUS, transitionAgentStatus, parkAgentForAttention, parkRationale };
