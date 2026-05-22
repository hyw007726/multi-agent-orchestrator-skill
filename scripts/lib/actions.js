const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { readJSON, updateJSON, updateJSONL, writeAtomic } = require("./locking");
const { stageAllChanges, stageCompletionChanges, commitWorktree } = require("./git-ops");
const { captureRecoveryAndReset } = require("./worktree-recovery");
const { checkCompletionOwnership, formatOwnershipViolation } = require("./ownership");
const { renderRestartPrompt } = require("./restart-prompt");
const { STATUS, transitionAgentStatus, parkAgentForAttention, parkRationale } = require("./status");
const { appendEvent } = require("./events");
const { pidMatchesCli, safeKill } = require("./process");
const { cliTemplateProcessMatch } = require("./cli-template");
const { VALIDATION_STATE, hasValidationCommand, isValidationRunning, validationTimeout, safeValidationFileSegment, readValidationResult, missingValidationResultIfStale, writeValidationResultFile, formatValidationCommandForLog, formatValidationTimeout } = require("./validation-control");
const { completionRequestDecisions, appendDecisionRecords, rejectPendingRequestsForAgent } = require("./approvals");

const RESTART_PROMPT_KEEP = 10;

function processActions(ctx, actions, arbitration = {}) {
  const { paths, log } = ctx;
  for (const rawAction of actions) {
    // restart_agent is a legacy alias for soft_restart.
    const action = rawAction.type === "restart_agent" ? { ...rawAction, type: "soft_restart" } : rawAction;

    if (action.type === "end_agent") {
      const snapshot = readJSON(paths.agents)[action.agent];
      if (!snapshot) {
        dropUnknownAgentAction(ctx, action);
        continue;
      }

      const validation = beginCompletionValidation(ctx, action, snapshot, arbitration);
      if (validation.state === VALIDATION_STATE.RUNNING) continue;
      if (validation.state === VALIDATION_STATE.FAILED) {
        handleValidationFailure(ctx, action.agent, validation);
        continue;
      }

      completeValidatedEndAgent(ctx, action, snapshot, arbitration);
      continue;
    }

    if (action.type === "soft_restart" || action.type === "hard_restart") {
      const snapshot = readJSON(paths.agents)[action.agent];
      if (!snapshot) {
        dropUnknownAgentAction(ctx, action);
        continue;
      }
      bumpRestartAndRespawn(ctx, {
        name: action.agent,
        instruction: action.instruction,
        reason: action.type,
        mode: action.type === "hard_restart" ? "hard" : "soft",
        requestIds: resolvedRequestIdsForAgent(action.agent, arbitration),
      });
    }
  }
}

// Single-use helper — used only by processActions above. Returns the
// approved+rejected request_ids in this arbitration response that target
// the given agent. We pass them through to bumpRestartAndRespawn so the
// pre-kill restart_scheduled event records which requests we're acting on,
// completing the audit trail.
function resolvedRequestIdsForAgent(agentName, arbitration) {
  if (!agentName || !arbitration) return [];
  const response = arbitration.response || {};
  const pending = Array.isArray(arbitration.pending) ? arbitration.pending : [];
  const approvedIds = new Set((response.approved || []).filter((a) => a && a.request_id).map((a) => a.request_id));
  const rejectedIds = new Set((response.rejected || []).filter((r) => r && r.request_id).map((r) => r.request_id));
  const resolved = new Set([...approvedIds, ...rejectedIds]);
  return pending
    .filter((r) => r && r.agent === agentName && r.request_id && resolved.has(r.request_id))
    .map((r) => r.request_id);
}

function dropUnknownAgentAction(ctx, action) {
  const { coordDir, log } = ctx;
  const agentName = action?.agent || "(missing)";
  const actionType = action?.type || "(missing)";
  const reason = `Arbitration action targeted unknown agent ${agentName}`;
  log(`${reason}; dropping ${actionType}.`);
  appendEvent(coordDir, "arbitration_action_dropped", {
    agent: action?.agent,
    reason,
    data: { action },
  });
}

function beginCompletionValidation(ctx, action, snapshot, arbitration) {
  const { paths, parsedConfig, log } = ctx;
  const cmd = snapshot.validate_cmd;
  if (!hasValidationCommand(cmd)) {
    return { state: VALIDATION_STATE.PASSED, log: "" };
  }
  if (isValidationRunning(snapshot)) {
    const requestDecisions = completionRequestDecisions(action, arbitration);
    markCompletionRequestsValidating(ctx, action.agent, requestDecisions.map((request) => request.request_id));
    log(`Validation already running for ${action.agent}; leaving completion request in validation state.`);
    return { state: VALIDATION_STATE.RUNNING };
  }

  const timeout = validationTimeout(snapshot, parsedConfig);
  const validationDir = path.join(path.dirname(paths.agents), "validation");
  fs.mkdirSync(validationDir, { recursive: true });
  const jobId = `${safeValidationFileSegment(action.agent)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const jobFile = path.join(validationDir, `${jobId}.job.json`);
  const resultFile = path.join(validationDir, `${jobId}.result.json`);
  const outputFile = path.join(validationDir, `${jobId}.log`);
  const startedAt = new Date().toISOString();
  const requestDecisions = completionRequestDecisions(action, arbitration);

  writeAtomic(jobFile, JSON.stringify({
    agent: action.agent,
    cmd,
    worktree: snapshot.worktree,
    timeoutMs: timeout.ms,
    timeoutMins: timeout.mins,
    outputFile,
    resultFile,
    startedAt,
  }, null, 2) + "\n");

  updateJSON(paths.agents, (agents) => {
    const agent = agents[action.agent];
    if (!agent || agent.status !== STATUS.RUNNING) return;
    agent.validation = {
      state: VALIDATION_STATE.RUNNING,
      job_id: jobId,
      started_at: startedAt,
      timeout_ms: timeout.ms,
      timeout_mins: timeout.mins,
      job_file: jobFile,
      result_file: resultFile,
      output_file: outputFile,
      requests: requestDecisions,
    };
  });
  markCompletionRequestsValidating(ctx, action.agent, requestDecisions.map((request) => request.request_id));

  const cmdText = formatValidationCommandForLog(cmd);
  log(`Running validation${Array.isArray(cmd) ? "" : " (shell form)"}: ${cmdText} (async, timeout ${formatValidationTimeout(timeout)}${timeout.fromHardCap ? ", hard cap" : ""})`);
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "validation-runner.js"), jobFile], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (err) => {
      writeValidationResultFile(resultFile, {
        passed: false,
        log: `Validation runner failed to start: ${err.message}`,
        error: err.message,
        completed_at: new Date().toISOString(),
      });
    });
    child.unref();
    updateJSON(paths.agents, (agents) => {
      const agent = agents[action.agent];
      if (!agent || !agent.validation || agent.validation.job_id !== jobId) return;
      agent.validation.pid = child.pid;
    });
    return { state: VALIDATION_STATE.RUNNING };
  } catch (err) {
    const failed = {
      state: VALIDATION_STATE.FAILED,
      log: `Validation runner failed to start: ${err.message}`,
      error: err.message,
    };
    updateJSON(paths.agents, (agents) => {
      const agent = agents[action.agent];
      if (!agent || !agent.validation || agent.validation.job_id !== jobId) return;
      agent.validation = {
        ...agent.validation,
        state: VALIDATION_STATE.FAILED,
        completed_at: new Date().toISOString(),
        result: { passed: false, error: err.message },
      };
    });
    return failed;
  }
}

function processFinishedValidations(ctx) {
  const { paths, parsedConfig, log } = ctx;
  const agents = readJSON(paths.agents);
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.status !== STATUS.RUNNING || !isValidationRunning(agent)) continue;
    const validation = agent.validation;
    let result = readValidationResult(validation);
    if (!result) {
      result = missingValidationResultIfStale(agent, validation, parsedConfig);
    }
    if (!result) continue;

    updateJSON(paths.agents, (current) => {
      const latest = current[name];
      if (!latest || !latest.validation || latest.validation.job_id !== validation.job_id) return;
      latest.validation = {
        ...latest.validation,
        state: result.passed ? VALIDATION_STATE.PASSED : VALIDATION_STATE.FAILED,
        completed_at: result.completed_at || new Date().toISOString(),
        result: {
          passed: Boolean(result.passed),
          status: result.status,
          signal: result.signal,
          error: result.error,
          timed_out: Boolean(result.timed_out),
        },
      };
    });

    const latest = readJSON(paths.agents)[name];
    const action = { type: "end_agent", agent: name };
    if (result.passed) {
      log(`Validation passed for ${name}.`);
      completeValidatedEndAgent(ctx, action, latest, validationArbitrationFromState({ ...latest.validation, agent: name }));
    } else {
      handleValidationFailure(ctx, name, { ...result, state: VALIDATION_STATE.FAILED, requests: validation.requests || [] });
    }
  }
}

function completeValidatedEndAgent(ctx, action, snapshot, arbitration) {
  const { paths, parsedConfig, log, coordDir } = ctx;
  if (!snapshot || snapshot.status !== STATUS.RUNNING) return;
  const ownership = checkCompletionOwnership(action.agent, snapshot, paths, log);
  if (!ownership.ok) {
    const violationText = formatOwnershipViolation(ownership);
    log(`Completion rejected for ${action.agent}: file ownership violation. ${ownership.summary}`);
    appendEvent(coordDir, "ownership_violation", {
      agent: action.agent,
      reason: ownership.summary,
      data: {
        changed_files: ownership.changedFiles,
        forbidden_violations: ownership.forbiddenViolations,
        outside_allowed: ownership.outsideAllowed,
      },
    });
    rejectCompletionRequestsForAgent(ctx, arbitration, action.agent, `Completion rejected: ${ownership.summary}`);
    rejectPendingRequestsForAgent(arbitration.response, arbitration.pending, action.agent, `Completion rejected: ${ownership.summary}`);
    bumpRestartAndRespawn(ctx, {
      name: action.agent,
      instruction: [
        "Completion was rejected because your worktree changed files outside your assigned ownership.",
        "",
        violationText,
        "",
        "Fix this by reverting, moving, or replacing every out-of-scope change. Keep only changes covered by allowed_paths and no changes covered by forbidden_paths, then submit a new review_request.",
      ].join("\n"),
      reason: "file ownership violation",
      mode: "soft",
      skipWipCommit: true,
    });
    return;
  }

  // Persist the end_agent intent to events.jsonl BEFORE we touch the
  // worktree (auto-commit), flip request status, or signal the worker. A
  // crash anywhere after this row lets an operator recover what we were
  // trying to do for this agent in this cycle, including which requests
  // were tied to the action.
  const endAgentRequestIds = resolvedRequestIdsForAgent(action.agent, arbitration);
  appendEvent(coordDir, "end_agent_intent", {
    agent: action.agent,
    reason: "arbitration end_agent before commit/kill",
    data: { request_ids: endAgentRequestIds },
  });

  // Auto-commit any uncommitted changes so the final merge phase picks them up.
  const worktree = snapshot.worktree;
  if (fs.existsSync(worktree)) {
    try {
      stageCompletionChanges(worktree, ownership.changedFiles);
      const taskSummary = (snapshot.task || "completed").toString().slice(0, 200);
      const commit = commitWorktree(worktree, `agent-${action.agent}: ${taskSummary}`);
      if (commit.committed) {
        log(`Agent ${action.agent}: auto-committed worktree state.`);
      } else {
        log(`Agent ${action.agent}: no changes to commit (already clean).`);
      }
    } catch (err) {
      log(`Agent ${action.agent}: auto-commit failed: ${err.message}`);
    }
  }

  // Atomic completion: resolve the approval and mark the agent COMPLETED
  // back-to-back with no intervening I/O. A crash here cannot leave us with
  // status=completed and an unresolved review_request — the COMPLETED write
  // is unreachable unless the resolution write has already landed.
  finalizeEndAgentCompletion(ctx, action, arbitration);
  appendEvent(coordDir, "agent_completed", { agent: action.agent });
  safeKill({ pid: snapshot.pid, expectedCli: expectedProcessForAgent(snapshot, parsedConfig), recordedCmdline: snapshot.spawned_cmdline, log, coordDir, agent: action.agent });
}

function handleValidationFailure(ctx, agentName, validation) {
  const { coordDir, log } = ctx;
  const validationLog = validation.log || validation.error || "Validation failed.";
  log(validationLog);
  log(`Validation failed for ${agentName} — converting to soft_restart.`);
  appendEvent(coordDir, "validation_failed", { agent: agentName, reason: validationLog.slice(0, 500) });
  resolveCompletionRequestsAfterValidationFailure(ctx, agentName, validation.requests || [], validationLog);
  bumpRestartAndRespawn(ctx, {
    name: agentName,
    instruction: `Validation failed! Please fix the errors:\n\n${validationLog}`,
    reason: "validation failure",
    mode: "soft",
  });
}

// Shared — used by the progress-timeout handler in orchestrator-loop and by processActions.
// Atomically updates the agent's restart_count / status in agents.json, then performs
// the side effects (kill, recovery/WIP-commit, subprocess respawn) OUTSIDE the lock so
// we never hold the lock across a subprocess (which would deadlock on spawn-agent's own
// updateJSON write).
function bumpRestartAndRespawn(ctx, { name, instruction, reason, mode, skipWipCommit = false, requestIds = [] }) {
  const { paths, parsedConfig, log, runId, coordDir } = ctx;
  const outcomeRef = { value: { kind: "missing" } };

  updateJSON(paths.agents, (agents) => {
    const agent = agents[name];
    if (!agent) return;

    const cliTool = agent.cli || parsedConfig.default_cli;

    if (!instruction) {
      transitionAgentStatus(agent, name, STATUS.TERMINATED, "no follow-up instruction", log);
      outcomeRef.value = { kind: "terminated", pid: agent.pid, cliTool, processMatch: expectedProcessForAgent(agent, parsedConfig), recordedCmdline: agent.spawned_cmdline, worktree: agent.worktree };
      appendEvent(coordDir, "restart_aborted", { agent: name, reason: "no instruction" });
      return;
    }

    const nextCount = (agent.restart_count ?? 0) + 1;
    const maxRestarts = parsedConfig.default_max_restarts;
    if (nextCount > maxRestarts) {
      // Keep agent.task as the immutable original description; the rotating
      // restart payload lives in last_instruction.
      agent.last_instruction = instruction;
      const attentionReason = `max restarts (${maxRestarts}) exhausted`;
      const nextSteps = parkRationale("restart_budget_exhausted");
      parkAgentForAttention(agent, name, attentionReason, log, { nextSteps });
      outcomeRef.value = { kind: "errored", pid: agent.pid, cliTool, processMatch: expectedProcessForAgent(agent, parsedConfig), recordedCmdline: agent.spawned_cmdline, worktree: agent.worktree };
      appendEvent(coordDir, "agent_parked", {
        agent: name,
        reason: attentionReason,
        data: { attention_at: agent.attention_at, next_steps: nextSteps },
      });
      return;
    }

    agents[name].restart_count = nextCount;
    agents[name].last_instruction = instruction;
    outcomeRef.value = {
      kind: "respawn",
      pid: agent.pid,
      cliTool,
      processMatch: expectedProcessForAgent(agent, parsedConfig),
      recordedCmdline: agent.spawned_cmdline,
      worktree: agent.worktree,
      kiloMode: agent.kilo_mode,
      validateCmd: agent.validate_cmd,
      timeoutMins: agent.timeout_mins,
      progressTimeoutMins: agent.progress_timeout_mins,
      validationTimeoutMins: agent.validation_timeout_mins,
      baseRef: agent.base_ref,
      attempt: nextCount,
    };
  });

  const outcome = outcomeRef.value;
  if (outcome.kind === "missing") return false;

  // Persist the intent to events.jsonl BEFORE any irreversible side effect
  // (kill, commit, recovery tag, respawn). A crash between intent and the
  // first side effect leaves a recoverable audit row; a crash mid-side-effect
  // leaves a transition that operators can map back to "the loop intended X
  // for agent Y at time Z" rather than guessing from agents.json alone.
  if (outcome.kind === "respawn") {
    appendEvent(coordDir, "restart_scheduled", {
      agent: name,
      reason: `${mode} restart - ${reason}`,
      data: {
        attempt: outcome.attempt,
        maxAttempts: parsedConfig.default_max_restarts,
        request_ids: requestIds,
      },
    });
  }

  // Side effects below the lock — none of these should re-enter updateJSON on the same file.
  safeKill({ pid: outcome.pid, expectedCli: outcome.processMatch || processMatchForCli(outcome.cliTool, parsedConfig), recordedCmdline: outcome.recordedCmdline, log, coordDir, agent: name });

  if (outcome.kind === "terminated") {
    log(`Agent ${name} terminated (no follow-up instruction).`);
    return false;
  }
  if (outcome.kind === "errored") {
    log(`Agent ${name} exceeded ${parsedConfig.default_max_restarts} restarts (${reason}). Marking errored, not respawning.`);
    return false;
  }

  // Worktree mutations (orthogonal to agents.json).
  if (fs.existsSync(outcome.worktree)) {
    if (mode === "hard") {
      const recovery = captureRecoveryAndReset(outcome.worktree, name, log, runId);
      if (recovery.error) {
        log(`Hard restart: recovery/reset failed — ${recovery.error}. Parking for attention.`);
        const recoveryReason = `hard restart recovery failed: ${recovery.error}`;
        let recoveryNextSteps, recoveryAttentionAt;
        updateJSON(paths.agents, (agents) => {
          if (agents[name]) {
            recoveryNextSteps = parkRationale("hard_restart_recovery_failed");
            parkAgentForAttention(agents[name], name, recoveryReason, log, { nextSteps: recoveryNextSteps });
            recoveryAttentionAt = agents[name].attention_at;
          }
        });
        if (recoveryAttentionAt) {
          appendEvent(coordDir, "agent_parked", {
            agent: name,
            reason: recoveryReason,
            data: { attention_at: recoveryAttentionAt, next_steps: recoveryNextSteps },
          });
        }
        return false;
      }
      if (recovery.tag) {
        log(`Hard restart: wiped worktree but preserved state at tag ${recovery.tag}.`);
        appendEvent(coordDir, "recovery_tag_created", { agent: name, data: { tag: recovery.tag, run_id: runId } });
        updateJSON(paths.agents, (agents) => {
          if (agents[name]) {
            agents[name].recovery_tag = recovery.tag;
            agents[name].recovery_tag_run_id = runId;
          }
        });
      } else {
        log(`Hard restart: worktree was already clean.`);
      }
    } else if (skipWipCommit) {
      log(`Skipping soft-restart WIP commit for ${name} (${reason}); preserving dirty worktree for the worker to fix.`);
    } else {
      try {
        stageAllChanges(outcome.worktree);
        const commit = commitWorktree(outcome.worktree, `WIP: orchestrator intervention (${reason})`);
        if (!commit.committed) {
          log(`No changes to commit for soft_restart on ${name}.`);
        }
      } catch (err) {
        log(`Soft-restart WIP commit failed for ${name}: ${err.message}`);
      }
    }
  }

  const respawned = respawnAgent({
    name,
    kiloMode: outcome.kiloMode,
    cliTool: outcome.cliTool,
    attempt: outcome.attempt,
    maxAttempts: parsedConfig.default_max_restarts,
    instruction,
    worktree: outcome.worktree,
    validateCmd: outcome.validateCmd,
    timeoutMins: outcome.timeoutMins,
    progressTimeoutMins: outcome.progressTimeoutMins,
    validationTimeoutMins: outcome.validationTimeoutMins,
    baseRef: outcome.baseRef,
    paths,
    log,
  });

  // Infrastructure-class respawn failures (spawn-agent.js exits non-zero, CLI
  // binary missing, EAGAIN, etc.) used to leave the agent with status=running
  // but a stale PID — the next loop cycle's vanished-worker check would then
  // transition it to `exited` with a phantom +1 on restart_count. Park the
  // agent for human attention instead, and refund the budget bump since this
  // attempt never reached the worker.
  if (!respawned) {
    const respawnReason = `respawn failed during ${mode} restart (${reason})`;
    let respawnNextSteps, respawnAttentionAt;
    updateJSON(paths.agents, (agents) => {
      if (!agents[name]) return;
      if (Number.isInteger(agents[name].restart_count) && agents[name].restart_count > 0) {
        agents[name].restart_count -= 1;
      }
      respawnNextSteps = parkRationale("respawn_failed");
      parkAgentForAttention(agents[name], name, respawnReason, log, { nextSteps: respawnNextSteps });
      respawnAttentionAt = agents[name].attention_at;
    });
    if (respawnAttentionAt) {
      appendEvent(coordDir, "agent_parked", {
        agent: name,
        reason: respawnReason,
        data: { attention_at: respawnAttentionAt, next_steps: respawnNextSteps },
      });
    }
  }
  return respawned;

  // Single-use helper — only called from bumpRestartAndRespawn above.
  function respawnAgent({ name, kiloMode, cliTool, attempt, maxAttempts, instruction, worktree, validateCmd, timeoutMins, progressTimeoutMins, validationTimeoutMins, baseRef, paths, log }) {
    const promptsDir = path.join(path.dirname(paths.agents), "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    const promptFile = path.join(promptsDir, `restart-${name}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, renderRestartPrompt({ name, instruction, worktree, paths, log }), "utf-8");
    sweepRestartPrompts(promptsDir, name, RESTART_PROMPT_KEEP);
    log(`Respawning agent ${name} using ${cliTool} (attempt ${attempt}/${maxAttempts})...`);
    const spawnArgs = [
      path.join(__dirname, "..", "spawn-agent.js"),
      "--agent", name,
      "--mode", kiloMode || "auto",
      "--prompt-file", promptFile,
      "--coord", path.dirname(paths.agents),
      "--cli", cliTool,
    ];
    appendSpawnArg(spawnArgs, "--validate", validateCmd, serializeValidateCmd);
    appendSpawnArg(spawnArgs, "--timeout", timeoutMins, String);
    appendSpawnArg(spawnArgs, "--progress-timeout", progressTimeoutMins, String);
    appendSpawnArg(spawnArgs, "--validation-timeout", validationTimeoutMins, String);
    appendSpawnArg(spawnArgs, "--base-ref", baseRef, String);
    try {
      const result = spawnSync("node", spawnArgs, { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        log(`Failed to respawn agent ${name}: spawn-agent.js exited with status ${result.status}.`);
        return false;
      }
      return true;
    } catch (err) {
      log(`Failed to respawn agent ${name}: ${err.message}`);
      return false;
    }

    function appendSpawnArg(args, flag, value, serialize) {
      if (value === undefined || value === null || value === "") return;
      args.push(flag, serialize(value));
    }

    function serializeValidateCmd(value) {
      return Array.isArray(value) ? JSON.stringify(value) : String(value);
    }
  }
}

function markCompletionRequestsValidating(ctx, agentName, requestIds) {
  const { paths } = ctx;
  const ids = new Set((requestIds || []).filter(Boolean));
  if (ids.size === 0) return;
  updateJSONL(paths.requests, (current) => {
    for (const request of current) {
      if (
        ids.has(request.request_id) &&
        request.agent === agentName &&
        request.type === "review_request" &&
        request.status === "pending"
      ) {
        request.status = "validating";
        request.validation_started_at = new Date().toISOString();
      }
    }
  });
}

function validationArbitrationFromState(validation = {}) {
  const requests = Array.isArray(validation.requests) ? validation.requests : [];
  return {
    response: {
      approved: requests.map((request) => ({
        request_id: request.request_id,
        decision: request.decision,
        reason: request.reason,
      })),
      rejected: [],
    },
    pending: requests.map((request) => ({
      request_id: request.request_id,
      agent: validation.agent,
      type: "review_request",
      status: "validating",
    })),
  };
}

function resolveCompletionRequestsAfterValidationFailure(ctx, agentName, requests, validationLog) {
  const { paths } = ctx;
  const ids = new Set((requests || []).map((request) => request.request_id).filter(Boolean));
  if (ids.size === 0) return;

  const resolvedCounts = new Map();
  updateJSONL(paths.requests, (current) => {
    for (const request of current) {
      if (
        ids.has(request.request_id) &&
        request.agent === agentName &&
        request.type === "review_request" &&
        (request.status === "pending" || request.status === "validating")
      ) {
        request.status = "resolved";
        request.validation_result = "failed";
        request.validation_resolved_at = new Date().toISOString();
        resolvedCounts.set(request.request_id, (resolvedCounts.get(request.request_id) || 0) + 1);
      }
    }
  });

  const resolvedAt = new Date().toISOString();
  const decisionsToAdd = [];
  for (const request of requests || []) {
    const count = resolvedCounts.get(request.request_id) || 0;
    if (count === 0) continue;
    decisionsToAdd.push({
      request_id: request.request_id,
      disposition: "approved",
      decision: request.decision || `Completion review processed for ${agentName}; validation failed and a restart was scheduled.`,
      reason: `${request.reason || "Completion review was validated by the orchestrator."} Validation failed: ${validationLog.slice(0, 300)}`,
      resolved_at: resolvedAt,
    });
  }
  appendDecisionRecords(ctx, decisionsToAdd);
}

function rejectCompletionRequestsForAgent(ctx, arbitration, agentName, reason) {
  const { paths, log } = ctx;
  const requests = completionRequestDecisions({ agent: agentName }, arbitration);
  const ids = new Set(requests.map((request) => request.request_id).filter(Boolean));
  if (ids.size === 0) return;

  const rejectedCounts = new Map();
  updateJSONL(paths.requests, (current) => {
    for (const request of current) {
      if (
        ids.has(request.request_id) &&
        request.agent === agentName &&
        request.type === "review_request" &&
        (request.status === "pending" || request.status === "validating")
      ) {
        request.status = "rejected";
        request.validation_result = "ownership_rejected";
        request.validation_resolved_at = new Date().toISOString();
        rejectedCounts.set(request.request_id, (rejectedCounts.get(request.request_id) || 0) + 1);
      }
    }
  });

  const resolvedAt = new Date().toISOString();
  const decisionsToAdd = [];
  for (const request of requests) {
    const count = rejectedCounts.get(request.request_id) || 0;
    if (count === 0) continue;
    decisionsToAdd.push({
      request_id: request.request_id,
      disposition: "rejected",
      decision: "Completion rejected",
      reason,
      resolved_at: resolvedAt,
    });
    log(`Rejected Request ${request.request_id}: ${reason}${count > 1 ? ` (${count} matching entries)` : ""}`);
  }
  appendDecisionRecords(ctx, decisionsToAdd);
}

// Resolves the agent's pending completion approval and then immediately marks
// the agent COMPLETED. The two writes are issued back-to-back with nothing
// between them, so the invariant "status=completed ⇒ approval resolved" holds
// even if the orchestrator crashes mid-flow.
function finalizeEndAgentCompletion(ctx, action, arbitration) {
  const { paths, log } = ctx;
  resolveEndAgentApprovalBeforeSignal(ctx, action, arbitration);
  updateJSON(paths.agents, (agents) => {
    if (!agents[action.agent]) return;
    transitionAgentStatus(agents[action.agent], action.agent, STATUS.COMPLETED, "validation passed, agent ended", log);
  });
}

function resolveEndAgentApprovalBeforeSignal(ctx, action, arbitration) {
  const { paths, log } = ctx;
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
  const toResolve = explicitlyApproved.length > 0
    ? explicitlyApproved
    : notRejected.length === 1
      ? notRejected
      : [];
  if (toResolve.length === 0) return;

  const ids = new Set(toResolve.map((request) => request.request_id));
  const resolvedCounts = new Map();
  updateJSONL(paths.requests, (current) => {
    for (const request of current) {
      if (
        ids.has(request.request_id) &&
        request.agent === action.agent &&
        request.type === "review_request" &&
        (request.status === "pending" || request.status === "validating")
      ) {
        request.status = "resolved";
        request.validation_result = "passed";
        request.validation_resolved_at = new Date().toISOString();
        resolvedCounts.set(request.request_id, (resolvedCounts.get(request.request_id) || 0) + 1);
      }
    }
  });

  const resolvedAt = new Date().toISOString();
  const decisionsToAdd = [];
  for (const request of toResolve) {
    const count = resolvedCounts.get(request.request_id) || 0;
    if (count === 0) continue;
    const approved = approvedById.get(request.request_id);
    const decision = approved?.decision || `Completion approved for ${action.agent}`;
    const reason = approved?.reason || "The orchestrator returned end_agent for this completion review request.";
    decisionsToAdd.push({
      request_id: request.request_id,
      disposition: "approved",
      decision,
      reason,
      resolved_at: resolvedAt,
    });
    log(`Approved Request ${request.request_id}: ${decision}${count > 1 ? ` (${count} matching pending entries)` : ""}`);
  }
  appendDecisionRecords(ctx, decisionsToAdd);
}

// Shared — used by orchestrator-loop's main loop and by bumpRestartAndRespawn.

function sweepRestartPrompts(promptsDir, agentName, keep = RESTART_PROMPT_KEEP) {
  const limit = Math.max(0, Number.isInteger(Number(keep)) ? Number(keep) : RESTART_PROMPT_KEEP);
  if (!fs.existsSync(promptsDir)) return;
  const prefix = `restart-${agentName}-`;
  const prompts = [];
  for (const name of fs.readdirSync(promptsDir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".txt")) continue;
    const filePath = path.join(promptsDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) prompts.push({ name, filePath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  prompts.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name));
  for (const stale of prompts.slice(limit)) {
    try { fs.unlinkSync(stale.filePath); } catch {}
  }
}

function expectedProcessForAgent(agent, parsedConfig) {
  if (typeof agent?.process_match === "string" && agent.process_match.trim() !== "") {
    return agent.process_match;
  }
  return processMatchForCli(agent?.cli || "kilo", parsedConfig);
}

function processMatchForCli(cli, parsedConfig) {
  const resolvedCli = cli || "kilo";
  return cliTemplateProcessMatch(resolvedCli, parsedConfig.cli_templates?.[resolvedCli]);
}

module.exports = {
  processActions,
  processFinishedValidations,
  sweepRestartPrompts,
  expectedProcessForAgent,
};
