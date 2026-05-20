const { readJSONL, updateJSON, updateJSONL, appendJSONL } = require("./locking");
const { stampProgressMilestone } = require("./progress-tracking");
const { RECENT_DECISION_LIMIT } = require("./arbitration");

function processApprovals(ctx, response, { pending = [] } = {}) {
  const { paths, log } = ctx;
  const resolvedAt = new Date().toISOString();
  const currentRequests = readJSONL(paths.requests);
  const pendingById = new Map();
  for (const request of currentRequests) {
    if (request && request.status === "pending" && request.request_id && !pendingById.has(request.request_id)) {
      pendingById.set(request.request_id, request);
    }
  }

  // Collect (request_id, intended disposition, decision payload) for every
  // approval/rejection that matches a still-pending request. Dedup on
  // request_id so a malformed response that lists the same id twice doesn't
  // produce two audit entries.
  const resolutions = [];
  const seenIds = new Set();
  for (const approved of response.approved || []) {
    const req = pendingById.get(approved.request_id);
    if (!req || req.status !== "pending" || seenIds.has(approved.request_id)) continue;
    seenIds.add(approved.request_id);
    resolutions.push({
      request_id: approved.request_id,
      status: "resolved",
      disposition: "approved",
      decision: approved.decision,
      reason: approved.reason,
    });
  }
  for (const rejected of response.rejected || []) {
    const req = pendingById.get(rejected.request_id);
    if (!req || req.status !== "pending" || seenIds.has(rejected.request_id)) continue;
    seenIds.add(rejected.request_id);
    resolutions.push({
      request_id: rejected.request_id,
      status: "rejected",
      disposition: "rejected",
      decision: "Request rejected",
      reason: rejected.reason,
    });
  }

  // Step 1 (must come first): flip request status. After this lands, the
  // next loop tick will not include these in `pending`, so a crash here is
  // recoverable — we just lose the audit row.
  const flippedCounts = new Map();
  updateJSONL(paths.requests, (current) => {
    for (const resolution of resolutions) {
      const count = markPendingRequestsById(current, resolution.request_id, resolution.status);
      if (count > 0) flippedCounts.set(resolution.request_id, count);
    }
  });

  // Step 2: append the decision audit for the resolutions we actually flipped.
  const decisionsToAdd = [];
  for (const resolution of resolutions) {
    const count = flippedCounts.get(resolution.request_id) || 0;
    if (count === 0) continue;
    decisionsToAdd.push({
      request_id: resolution.request_id,
      disposition: resolution.disposition,
      decision: resolution.decision,
      reason: resolution.reason,
      resolved_at: resolvedAt,
    });
    const verbed = resolution.disposition === "approved" ? "Approved" : "Rejected";
    const trailingText = resolution.disposition === "approved" ? resolution.decision : resolution.reason;
    log(`${verbed} Request ${resolution.request_id}: ${trailingText}${count > 1 ? ` (${count} matching pending entries)` : ""}`);
  }
  appendDecisionRecords(ctx, decisionsToAdd);

  resetMilestonesOnWaitResolutions(ctx, response, pending);
}

// Single-use helper — called from processApprovals above. A progress_timeout
// request that is approved without a soft/hard restart action targeting the
// same agent counts as a "wait" resolution: the orchestrator chose to let
// the agent continue. Treat that as a milestone so subsequent stalls don't
// immediately escalate based on the stale history.
function resetMilestonesOnWaitResolutions(ctx, response, pending) {
  const { paths, log } = ctx;
  const approvedIds = new Set(
    (response.approved || [])
      .map((entry) => entry && entry.request_id)
      .filter(Boolean),
  );
  if (approvedIds.size === 0) return;

  const restartActionAgents = new Set(
    (response.actions || [])
      .filter((action) => action && (action.type === "soft_restart" || action.type === "hard_restart" || action.type === "restart_agent" || action.type === "end_agent"))
      .map((action) => action.agent)
      .filter(Boolean),
  );

  const waitAgents = new Set();
  for (const request of pending) {
    if (!request || request.type !== "progress_timeout") continue;
    if (!approvedIds.has(request.request_id)) continue;
    if (restartActionAgents.has(request.agent)) continue;
    waitAgents.add(request.agent);
  }

  for (const agentName of waitAgents) {
    const stamp = stampProgressMilestone(paths, agentName, "wait_resolution");
    if (stamp) log(`Agent ${agentName}: arbitration approved progress_timeout without a restart; resetting progress-timeout window at ${stamp}.`);
  }
}

function appendDecisionRecords(ctx, decisionsToAdd) {
  const { paths, log, runId } = ctx;
  if (decisionsToAdd.length === 0) return;
  // Stamp every decision with the current run_id so readRecentDecisions can skip
  // prior-run history. Done here (rather than at each call site) so a missed
  // call site can't silently emit unstamped decisions.
  const stamped = decisionsToAdd.map((d) => (runId && d && d.run_id === undefined ? { ...d, run_id: runId } : d));
  appendJSONL(paths.decisionsAudit, stamped);
  updateJSON(paths.decisions, (decisions) => {
    decisions.push(...stamped);
    if (decisions.length > RECENT_DECISION_LIMIT) {
      const archive = decisions.length - RECENT_DECISION_LIMIT;
      log(`Trimming ${archive} old decisions from decisions.json; full audit remains in decisions.jsonl.`);
      decisions.splice(0, archive);
    }
  });
}

function completionRequestDecisions(action, arbitration = {}) {
  const response = arbitration.response || {};
  const pending = Array.isArray(arbitration.pending) ? arbitration.pending : [];
  const approvedById = new Map();
  for (const approved of response.approved || []) {
    if (approved && approved.request_id && !approvedById.has(approved.request_id)) {
      approvedById.set(approved.request_id, approved);
    }
  }
  const rejectedIds = new Set((response.rejected || [])
    .filter((rejected) => rejected && rejected.request_id)
    .map((rejected) => rejected.request_id));

  const completionRequests = pending.filter((request) =>
    request &&
    request.agent === action.agent &&
    request.type === "review_request" &&
    (request.status === "pending" || request.status === "validating") &&
    request.request_id
  );
  const explicitlyApproved = completionRequests.filter((request) => approvedById.has(request.request_id));
  const notRejected = completionRequests.filter((request) => !rejectedIds.has(request.request_id));
  const selected = explicitlyApproved.length > 0
    ? explicitlyApproved
    : notRejected.length === 1
      ? notRejected
      : [];

  return selected.map((request) => {
    const approved = approvedById.get(request.request_id);
    return {
      request_id: request.request_id,
      decision: approved?.decision || `Completion approved for ${action.agent}`,
      reason: approved?.reason || "The orchestrator returned end_agent for this completion review request.",
    };
  });
}

function markPendingRequestsById(requests, requestId, status) {
  let count = 0;
  for (const request of requests) {
    if (request.request_id === requestId && request.status === "pending") {
      request.status = status;
      count++;
    }
  }
  return count;
}

function rejectPendingRequestsForAgent(response, pending, agentName, reason) {
  if (!response || !Array.isArray(pending)) return;
  const ids = new Set(pending
    .filter((request) => request && request.agent === agentName && request.status === "pending" && request.request_id)
    .map((request) => request.request_id));
  if (ids.size === 0) return;

  response.approved = (response.approved || []).filter((entry) => !ids.has(entry.request_id));
  const rejectedIds = new Set((response.rejected || []).map((entry) => entry.request_id));
  response.rejected = response.rejected || [];
  for (const requestId of ids) {
    if (rejectedIds.has(requestId)) continue;
    response.rejected.push({ request_id: requestId, reason });
  }
}

module.exports = {
  processApprovals,
  appendDecisionRecords,
  completionRequestDecisions,
  rejectPendingRequestsForAgent,
};
