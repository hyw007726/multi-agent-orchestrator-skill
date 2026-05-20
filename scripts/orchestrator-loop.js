#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { loadConfig } = require("./lib/config");
const { pidMatchesCli, getProcessCommandMap, safeKill } = require("./lib/process");
const { acquireInstanceLock, readJSON, readJSONL, updateJSON, updateJSONL, appendJSONL, writeAtomic } = require("./lib/locking");
const { renderRestartPrompt } = require("./lib/restart-prompt");
const { STATUS, transitionAgentStatus, parkAgentForAttention, parkRationale } = require("./lib/status");
const { appendEvent } = require("./lib/events");
const { cliTemplateMode, cliTemplateProcessMatch, spawnCliTemplate } = require("./lib/cli-template");
const { extractJsonObject } = require("./lib/provider-output");
const { tailLines } = require("./lib/log-tail");
const { discoverDefaultBaseBranch } = require("./lib/git-base");
const { stageAllChanges, stageCompletionChanges, gitStdout, runGit, gitErrorDetails, commitWorktree } = require("./lib/git-ops");
const { captureRecoveryAndReset } = require("./lib/worktree-recovery");
const { checkCompletionOwnership, formatOwnershipViolation, collectOwnershipChangedFiles, pathPatternMatches } = require("./lib/ownership");
const { consolidateStagedRequests, readStagedRequests } = require("./lib/staged-requests");
const { VALIDATION_STATE, VALIDATION_HARD_CAP_MINS, validationTimeout, firstPositiveNumber, formatValidationTimeout, hasValidationCommand, formatValidationCommandForLog, isValidationRunning, readValidationResult, missingValidationResultIfStale, writeValidationResultFile, safeValidationFileSegment, processAlive, killValidationRunner } = require("./lib/validation-control");

const RECENT_DECISION_LIMIT = 30;
const RESTART_PROMPT_KEEP = 10;
const HEARTBEAT_GRACE_PHASES = new Set(["starting", "reading", "planning", "testing", "running_tests", "building", "installing", "debugging"]);
const LEGACY_ABORT_FLAG_STARTUP_GRACE_MS = 10_000;

// ─── Entry ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  runLoop();
}

async function runLoop() {
  const config = parseArgs();
  const paths = getPaths(config.coordDir);
  const parsedConfig = loadConfig();

  if (!fs.existsSync(paths.requests) || !fs.existsSync(paths.decisions) || !fs.existsSync(paths.context)) {
    console.error("Missing coordination files. Run bootstrap first.");
    process.exit(1);
  }

  // Refuse to start a second loop on the same coord/. Held for the full run; released
  // on every teardown path below. The stale option recovers automatically if a prior
  // loop was SIGKILL'd without running its teardown.
  let instanceLock;
  try {
    instanceLock = acquireInstanceLock(config.coordDir);
  } catch (err) {
    if (err && err.code === "ELOCKED") {
      console.error(formatInstanceLockError(err));
      process.exit(1);
    }
    throw err;
  }
  const runId = instanceLock.runId;
  const currentRunStartedAt = readJSONIfExists(path.join(config.coordDir, "current_run.json"))?.started_at || null;
  const abortFlagPath = path.join(config.coordDir, "abort.flag");
  const releaseInstanceLock = () => { instanceLock.release(); };
  process.once("SIGTERM", () => { releaseInstanceLock(); process.exit(0); });
  process.once("SIGINT",  () => { releaseInstanceLock(); process.exit(0); });
  process.once("beforeExit", releaseInstanceLock);
  process.once("uncaughtException", (err) => {
    console.error(err);
    releaseInstanceLock();
    process.exit(1);
  });

  const log = (msg) => appendLog(config.logFile, msg);
  if (config.fixedPollIntervalMs) {
    log(`Starting Orchestrator Loop (fixed poll: ${config.fixedPollIntervalMs}ms)`);
  } else {
    log(`Starting Orchestrator Loop (adaptive poll: ${parsedConfig.poll_min_ms}–${parsedConfig.poll_max_ms}ms; backs off when idle)`);
  }
  log(`Orchestrator CLI: '${parsedConfig.orchestrator_cli}'  |  max restarts: ${parsedConfig.default_max_restarts}  |  CLI failure threshold: ${parsedConfig.orchestrator_failure_threshold}`);
  log(`Acquired singleton lock on ${instanceLock.markerPath} (PID ${process.pid}, run_id ${runId}).`);
  ensureDecisionAuditLog(paths, log);

  launchDashboard(config, parsedConfig, log);

  const agentProgress = {};
  let consecutiveCliFailures = 0;
  let pollMs = parsedConfig.poll_min_ms;
  let aborted = false;
  const POLL_BACKOFF = 1.5;

  while (true) {
    consolidateStagedRequests(paths);
    let cycleHadPending = false;
    try {
      // ── Abort flag (soft stop — preserves worktrees) ─────────────────────
      const abortFlag = inspectAbortFlag(abortFlagPath, currentRunStartedAt);
      if (abortFlag.stale) {
        log(`Ignoring stale abort.flag written at ${abortFlag.writtenAt || "(unknown)"} before current run started at ${currentRunStartedAt || "(unknown)"}; removing it.`);
        try { fs.unlinkSync(abortFlagPath); } catch {}
      } else if (abortFlag.active) {
        log("ABORT SIGNAL RECEIVED. Stopping running agents (worktrees preserved)...");
        const toKill = [];
        const validationsToKill = [];
        appendEvent(config.coordDir, "abort_requested", {
          reason: "abort.flag detected",
          data: { pid: abortFlag.pid || undefined, written_at: abortFlag.writtenAt || undefined },
        });
        updateJSON(paths.agents, (agents) => {
          for (const name in agents) {
            if (agents[name].status === "running") {
              toKill.push({
                pid: agents[name].pid,
                expectedProcess: expectedProcessForAgent(agents[name], parsedConfig),
                recordedCmdline: agents[name].spawned_cmdline,
                name,
              });
              if (isValidationRunning(agents[name]) && Number.isInteger(agents[name].validation.pid)) {
                validationsToKill.push({ pid: agents[name].validation.pid, name });
              }
              transitionAgentStatus(agents[name], name, STATUS.TERMINATED, "abort signal", log);
            }
          }
        });
        // Kill outside the lock — the lock's job is to protect agents.json, not gate signals.
        for (const { pid, expectedProcess, recordedCmdline, name } of toKill) safeKill({ pid, expectedCli: expectedProcess, recordedCmdline, log, coordDir: config.coordDir, agent: name });
        for (const { pid, name } of validationsToKill) killValidationRunner(pid, name, log);
        log("All running agents stopped. Worktree contents preserved (run `git status` in each worktree to inspect/discard).");
        try { fs.unlinkSync(abortFlagPath); } catch {}
        aborted = true;
        break;
      }

      processFinishedValidations(paths, parsedConfig, log);

      // ── Per-agent liveness + progress checks ─────────────────────────────
      // Snapshot read for diagnostics; each actual mutation takes its own lock.
      const snapshot = readJSON(paths.agents);
      let allRequests = readJSONL(paths.requests);

      // Single ps invocation for this tick. Every isAgentProcessAlive call
      // below reads from the resulting pid→cmdline map instead of spawning
      // its own `ps -p <pid>`. With N running agents the previous shape was
      // N+ subprocesses per cycle just for liveness checks.
      const cmdMap = getProcessCommandMap();

      for (const name in snapshot) {
        if (snapshot[name].status !== "running") continue;
        const agent = snapshot[name];
        if (isValidationRunning(agent)) {
          continue;
        }

        // Process gone? Check whether the agent requested completion first.
        if (!isAgentProcessAlive(agent, parsedConfig, cmdMap)) {
          const agentLogFile = path.join(config.coordDir, "logs", `${name}.log`);
          const stagedRequests = readStagedRequests(paths);
          const inLog = allRequests.some(
            (r) => r.agent === name && r.type === "review_request" && r.status === "pending"
          );
          const inStaging = stagedRequests.some(
            (r) => r.agent === name && r.type === "review_request" && r.status === "pending"
          );
          const hasPendingReview = inLog || inStaging;

          // If the review request exists only in staging (not yet consolidated
          // into requests.jsonl), consolidate now so the arbitration pipeline sees it.
          if (!inLog && inStaging) {
            consolidateStagedRequests(paths);
          }

          if (!hasPendingReview) {
            // Re-consolidate in case a request landed between readStagedRequests
            // and the check above. Then re-read jsonl for a final verdict.
            consolidateStagedRequests(paths);
            const freshRequests = readJSONL(paths.requests);
            const freshPending = freshRequests.some(
              (r) => r.agent === name && r.type === "review_request" && r.status === "pending"
            );
            if (freshPending) {
              log(`Agent ${name} (PID ${agent.pid}) process exited, but a review request arrived post-snapshot. Waiting for arbitration.`);
              continue;
            }
            updateJSON(paths.agents, (agents) => {
              if (agents[name] && agents[name].status === "running") {
                agents[name].exit_log_tail = readTail(agentLogFile, 50);
                transitionAgentStatus(agents[name], name, STATUS.EXITED, "process vanished without review request", log);
              }
            });
            appendEvent(config.coordDir, "process_exited", { agent: name, pid: agent.pid, reason: "vanished without review request" });
            continue;
          }
          log(`Agent ${name} (PID ${agent.pid}) process exited, but a review request is pending. Waiting for arbitration.`);
          continue;
        }

        // Liveness ("Killer") timeout: no log output for `timeout_mins`.
        const logFile = path.join(config.coordDir, "logs", `${name}.log`);
        let lastActivity = readAgentCurrentStartMs(agent, { name, log });
        if (fs.existsSync(logFile)) lastActivity = fs.statSync(logFile).mtime.getTime();

        const timeoutMins = agent.timeout_mins || parsedConfig.default_timeout_mins;
        if (Date.now() - lastActivity > timeoutMins * 60 * 1000) {
          log(`Agent ${name} idle (no log output) for ${timeoutMins} mins. Killing.`);
          safeKill({ pid: agent.pid, expectedCli: expectedProcessForAgent(agent, parsedConfig), recordedCmdline: agent.spawned_cmdline, log, coordDir: config.coordDir, agent: name });
          const livenessReason = `liveness timeout - idle ${timeoutMins} mins`;
          let livenessNextSteps, livenessAttentionAt;
          updateJSON(paths.agents, (agents) => {
            if (agents[name] && agents[name].status === "running") {
              livenessNextSteps = parkRationale("liveness_timeout");
              parkAgentForAttention(agents[name], name, livenessReason, log, { nextSteps: livenessNextSteps });
              livenessAttentionAt = agents[name].attention_at;
            }
          });
          if (livenessAttentionAt) {
            appendEvent(config.coordDir, "agent_parked", {
              agent: name,
              reason: livenessReason,
              data: { attention_at: livenessAttentionAt, next_steps: livenessNextSteps },
            });
          }
          continue;
        }

        // Progress timeout: process is alive, but git-visible work is not changing.
        // Per-tick we only compute a cheap content hash of `git status` — one git
        // invocation per agent instead of the previous four. The detailed diff
        // snapshot (4 git calls) is built on-demand only when a progress-timeout
        // request is actually about to be written, which is rare.
        const progressMins = agent.progress_timeout_mins || parsedConfig.default_progress_timeout_mins;
        const currentDiffHash = readDiffHash(agent.worktree);
        const heartbeat = readProgressHeartbeat(paths.progressDir, name);
        const tracker = agentProgress[name];
        if (!tracker) {
          agentProgress[name] = {
            last_diff_hash: currentDiffHash,
            last_progress_time: Date.now(),
            last_heartbeat_mtime: heartbeat.mtimeMs || 0,
            heartbeat_grace_count: 0,
          };
        } else if (tracker.last_diff_hash !== currentDiffHash) {
          tracker.last_diff_hash = currentDiffHash;
          tracker.last_progress_time = Date.now();
          tracker.last_heartbeat_mtime = heartbeat.mtimeMs || tracker.last_heartbeat_mtime || 0;
          tracker.heartbeat_grace_count = 0;
          // Real code change ⇒ any prior progress_timeout history is no longer
          // load-bearing for escalation. Persist the reset to agents.json so
          // the windowing survives loop restarts.
          stampProgressMilestone(paths, name, "code_change");
        } else {
          if (heartbeatChanged(heartbeat, tracker)) {
            tracker.last_heartbeat_mtime = heartbeat.mtimeMs;
            if (shouldGrantHeartbeatGrace(heartbeat, tracker)) {
              tracker.last_progress_time = Date.now();
              tracker.heartbeat_grace_count += 1;
              log(`Agent ${name} heartbeat updated in phase '${heartbeat.phase || "(unknown)"}'; granting one bounded progress grace.`);
              appendEvent(config.coordDir, "heartbeat_grace_used", {
                agent: name,
                reason: `phase ${heartbeat.phase || "(unknown)"}`,
                data: { heartbeat_mtime: heartbeat.mtime, grace_count: tracker.heartbeat_grace_count },
              });
              continue;
            }
          }

          if (Date.now() - tracker.last_progress_time > progressMins * 60 * 1000) {
            if (hasPendingProgressTimeoutRequest(allRequests, name)) {
              tracker.last_progress_time = Date.now();
              log(`Agent ${name} still has a pending progress-timeout request; waiting for arbitration.`);
              continue;
            }

            log(`Agent ${name} stuck for ${progressMins} mins (no code changes). Writing progress-timeout request for arbitration.`);
            // Now — and only now — pay for the full multi-call diff snapshot
            // that's about to be embedded in the request.
            const detailedDiff = readDiffSnapshot(agent.worktree);
            const request = buildProgressTimeoutRequest({
              agentName: name,
              agent,
              progressMins,
              logFile,
              diffSnapshot: detailedDiff,
              heartbeat,
              paths,
              allRequests,
              parsedConfig,
            });
            appendJSONL(paths.requests, [request]);
            appendEvent(config.coordDir, "progress_timeout_requested", {
              agent: name,
              reason: `no git-visible changes for ${progressMins} minute(s)`,
              data: { request_id: request.request_id, type: request.type, source: request.source },
            });
            tracker.last_progress_time = Date.now();
            allRequests = readJSONL(paths.requests);
            continue;
          }
        }
      }

      // ── Pending requests / arbitration ───────────────────────────────────
      const pending = allRequests.filter((p) => p.status === "pending");

      if (pending.length > 0) {
        cycleHadPending = true;
        log(`Found ${pending.length} pending requests.`);
        const context = readJSON(paths.context);
        const durableDecisions = readTextIfExists(paths.decisionsMd);
        const callerContext = readTextIfExists(paths.callerContextMd);
        const recentDecisions = readRecentDecisions(paths.decisions, runId);
        const agentsForPrompt = readJSON(paths.agents);

        const worktreeStates = collectWorktreeStates(pending, agentsForPrompt);
        const prompt = buildBoundedArbitrationPrompt({
          pending,
          context,
          durableDecisions,
          recentDecisions,
          worktreeStates,
          callerContext,
          log,
        });
        const response = await callOrchestratorCli(prompt, parsedConfig, config.maxRetries, log, abortFlagPath);

        if (!response) {
          consecutiveCliFailures++;
          log(`callOrchestratorCli failed (consecutive: ${consecutiveCliFailures}/${parsedConfig.orchestrator_failure_threshold})`);
          if (consecutiveCliFailures >= parsedConfig.orchestrator_failure_threshold) {
            writeStalledFlag(config.coordDir, consecutiveCliFailures, pending, parsedConfig, log);
          }
        } else {
          if (consecutiveCliFailures > 0) {
            consecutiveCliFailures = 0;
            clearStalledFlag(config.coordDir, log);
          }
          processActions(response.actions || [], paths, parsedConfig, log, { response, pending });
          processApprovals(response, paths, log, { pending });
        }
      } else {
        // ── All-done check ────────────────────────────────────────────────
        const agents = readJSON(paths.agents);
        const entries = Object.values(agents);
        // needs_attention is terminal for "can the loop exit?": a parked agent
        // is awaiting a human and the loop will never advance it on its own.
        const allDone = entries.length > 0 &&
          entries.every((a) => a.status === "completed" || a.status === "terminated" || a.status === "errored" || a.status === "exited" || a.status === STATUS.NEEDS_ATTENTION);
        if (allDone) {
          finalize(config, paths, parsedConfig, log);
          break;
        }
      }

      pollMs = nextPollMs(cycleHadPending);
      await sleep(pollMs);
    } catch (error) {
      log(`Loop Error: ${error.message}`);
      pollMs = config.fixedPollIntervalMs ?? parsedConfig.poll_min_ms;
      await sleep(pollMs);
    }
  }

  // Natural exit — release the singleton lock explicitly for prompt cleanup.
  releaseInstanceLock();
  log(`Released singleton lock on ${instanceLock.markerPath}.`);

  if (aborted) {
    log("Coordination directory preserved for post-abort inspection (worktrees also preserved).");
  }

  // Single-use helper — only called from the main while loop above.
  // Picks the next sleep based on whether this cycle saw pending requests:
  //   • fixed override wins if --poll-interval was set
  //   • pending found → reset to min (stay responsive while batch is being worked through)
  //   • idle cycle  → multiply by POLL_BACKOFF, capped at max
  function nextPollMs(activeCycle) {
    if (config.fixedPollIntervalMs) return config.fixedPollIntervalMs;
    if (activeCycle) return parsedConfig.poll_min_ms;
    const next = Math.round(pollMs * POLL_BACKOFF);
    return Math.min(next, parsedConfig.poll_max_ms);
  }

  // ── Inner helpers ──────────────────────────────────────────────────────

  function launchDashboard(config, parsedConfig, log) {
    try {
      const dashboardPath = path.join(__dirname, "dashboard.js");
      const manualCommand = `node ${shellQuote(dashboardPath)} --coord ${shellQuote(config.coordDir)}`;
      const launchDecision = shouldAutoLaunchDashboard(parsedConfig.launch_dashboard);
      if (!launchDecision.launch) {
        log(`${launchDecision.reason}. Run manually in another terminal: ${manualCommand}`);
        return;
      }
      if (process.platform === "darwin") {
        const command = [
          "cd", shellQuote(process.cwd()),
          "&&", "node", shellQuote(dashboardPath),
          "--coord", shellQuote(config.coordDir),
        ].join(" ");
        runAppleScriptTerminal(command);
        log("Launched dashboard terminal.");
      } else {
        log(`Dashboard can be run manually in another terminal: ${manualCommand}`);
      }
    } catch (e) {
      log(`Failed to launch dashboard: ${e.message}`);
    }
  }

  function processActions(actions, paths, parsedConfig, log, arbitration = {}) {
    for (const rawAction of actions) {
      // restart_agent is a legacy alias for soft_restart.
      const action = rawAction.type === "restart_agent" ? { ...rawAction, type: "soft_restart" } : rawAction;

      if (action.type === "end_agent") {
        const snapshot = readJSON(paths.agents)[action.agent];
        if (!snapshot) {
          dropUnknownAgentAction(action, log);
          continue;
        }

        const validation = beginCompletionValidation(action, snapshot, arbitration, paths, parsedConfig, log);
        if (validation.state === VALIDATION_STATE.RUNNING) continue;
        if (validation.state === VALIDATION_STATE.FAILED) {
          handleValidationFailure(action.agent, validation, paths, parsedConfig, log);
          continue;
        }

        completeValidatedEndAgent(action, snapshot, arbitration, paths, parsedConfig, log);
        continue;
      }

      if (action.type === "soft_restart" || action.type === "hard_restart") {
        const snapshot = readJSON(paths.agents)[action.agent];
        if (!snapshot) {
          dropUnknownAgentAction(action, log);
          continue;
        }
        bumpRestartAndRespawn({
          name: action.agent,
          instruction: action.instruction,
          reason: action.type,
          paths,
          parsedConfig,
          mode: action.type === "hard_restart" ? "hard" : "soft",
          log,
        });
      }
    }
  }

  function dropUnknownAgentAction(action, log) {
    const agentName = action?.agent || "(missing)";
    const actionType = action?.type || "(missing)";
    const reason = `Arbitration action targeted unknown agent ${agentName}`;
    log(`${reason}; dropping ${actionType}.`);
    appendEvent(config.coordDir, "arbitration_action_dropped", {
      agent: action?.agent,
      reason,
      data: { action },
    });
  }

  function beginCompletionValidation(action, snapshot, arbitration, paths, parsedConfig, log) {
    const cmd = snapshot.validate_cmd;
    if (!hasValidationCommand(cmd)) {
      return { state: VALIDATION_STATE.PASSED, log: "" };
    }
    if (isValidationRunning(snapshot)) {
      const requestDecisions = completionRequestDecisions(action, arbitration);
      markCompletionRequestsValidating(paths, action.agent, requestDecisions.map((request) => request.request_id));
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
    markCompletionRequestsValidating(paths, action.agent, requestDecisions.map((request) => request.request_id));

    const cmdText = formatValidationCommandForLog(cmd);
    log(`Running validation${Array.isArray(cmd) ? "" : " (shell form)"}: ${cmdText} (async, timeout ${formatValidationTimeout(timeout)}${timeout.fromHardCap ? ", hard cap" : ""})`);
    try {
      const child = spawn(process.execPath, [path.join(__dirname, "validation-runner.js"), jobFile], {
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

  function processFinishedValidations(paths, parsedConfig, log) {
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
        completeValidatedEndAgent(action, latest, validationArbitrationFromState({ ...latest.validation, agent: name }), paths, parsedConfig, log);
      } else {
        handleValidationFailure(name, { ...result, state: VALIDATION_STATE.FAILED, requests: validation.requests || [] }, paths, parsedConfig, log);
      }
    }
  }

  function completeValidatedEndAgent(action, snapshot, arbitration, paths, parsedConfig, log) {
    if (!snapshot || snapshot.status !== STATUS.RUNNING) return;
    const ownership = checkCompletionOwnership(action.agent, snapshot, paths, log);
    if (!ownership.ok) {
      const violationText = formatOwnershipViolation(ownership);
      log(`Completion rejected for ${action.agent}: file ownership violation. ${ownership.summary}`);
      appendEvent(config.coordDir, "ownership_violation", {
        agent: action.agent,
        reason: ownership.summary,
        data: {
          changed_files: ownership.changedFiles,
          forbidden_violations: ownership.forbiddenViolations,
          outside_allowed: ownership.outsideAllowed,
        },
      });
      rejectCompletionRequestsForAgent(arbitration, paths, action.agent, `Completion rejected: ${ownership.summary}`, log);
      rejectPendingRequestsForAgent(arbitration.response, arbitration.pending, action.agent, `Completion rejected: ${ownership.summary}`);
      bumpRestartAndRespawn({
        name: action.agent,
        instruction: [
          "Completion was rejected because your worktree changed files outside your assigned ownership.",
          "",
          violationText,
          "",
          "Fix this by reverting, moving, or replacing every out-of-scope change. Keep only changes covered by allowed_paths and no changes covered by forbidden_paths, then submit a new review_request.",
        ].join("\n"),
        reason: "file ownership violation",
        paths,
        parsedConfig,
        mode: "soft",
        skipWipCommit: true,
        log,
      });
      return;
    }

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
    finalizeEndAgentCompletion(action, arbitration, paths, log);
    appendEvent(config.coordDir, "agent_completed", { agent: action.agent });
    safeKill({ pid: snapshot.pid, expectedCli: expectedProcessForAgent(snapshot, parsedConfig), recordedCmdline: snapshot.spawned_cmdline, log, coordDir: config.coordDir, agent: action.agent });
  }

  function handleValidationFailure(agentName, validation, paths, parsedConfig, log) {
    const validationLog = validation.log || validation.error || "Validation failed.";
    log(validationLog);
    log(`Validation failed for ${agentName} — converting to soft_restart.`);
    appendEvent(config.coordDir, "validation_failed", { agent: agentName, reason: validationLog.slice(0, 500) });
    resolveCompletionRequestsAfterValidationFailure(paths, agentName, validation.requests || [], validationLog, log);
    bumpRestartAndRespawn({
      name: agentName,
      instruction: `Validation failed! Please fix the errors:\n\n${validationLog}`,
      reason: "validation failure",
      paths,
      parsedConfig,
      mode: "soft",
      log,
    });
  }

  // Shared — used by the progress-timeout handler above and by processActions.
  // Atomically updates the agent's restart_count / status in agents.json, then performs
  // the side effects (kill, recovery/WIP-commit, subprocess respawn) OUTSIDE the lock so
  // we never hold the lock across a subprocess (which would deadlock on spawn-agent's own
  // updateJSON write).
  function bumpRestartAndRespawn({ name, instruction, reason, paths, parsedConfig, mode, skipWipCommit = false, log }) {
    const outcomeRef = { value: { kind: "missing" } };

    updateJSON(paths.agents, (agents) => {
      const agent = agents[name];
      if (!agent) return;

      const cliTool = agent.cli || parsedConfig.default_cli;

      if (!instruction) {
        transitionAgentStatus(agent, name, STATUS.TERMINATED, "no follow-up instruction", log);
        outcomeRef.value = { kind: "terminated", pid: agent.pid, cliTool, processMatch: expectedProcessForAgent(agent, parsedConfig), recordedCmdline: agent.spawned_cmdline, worktree: agent.worktree };
        appendEvent(config.coordDir, "restart_aborted", { agent: name, reason: "no instruction" });
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
        appendEvent(config.coordDir, "agent_parked", {
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

    // Side effects below the lock — none of these should re-enter updateJSON on the same file.
    safeKill({ pid: outcome.pid, expectedCli: outcome.processMatch || processMatchForCli(outcome.cliTool, parsedConfig), recordedCmdline: outcome.recordedCmdline, log, coordDir: config.coordDir, agent: name });

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
            appendEvent(config.coordDir, "agent_parked", {
              agent: name,
              reason: recoveryReason,
              data: { attention_at: recoveryAttentionAt, next_steps: recoveryNextSteps },
            });
          }
          return false;
        }
        if (recovery.tag) {
          log(`Hard restart: wiped worktree but preserved state at tag ${recovery.tag}.`);
          appendEvent(config.coordDir, "recovery_tag_created", { agent: name, data: { tag: recovery.tag, run_id: runId } });
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

    appendEvent(config.coordDir, "restart_scheduled", {
      agent: name,
      reason: `${mode} restart - ${reason}`,
      data: { attempt: outcome.attempt, maxAttempts: parsedConfig.default_max_restarts },
    });

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
        appendEvent(config.coordDir, "agent_parked", {
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
        path.join(__dirname, "spawn-agent.js"),
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


  // Marks resolved/rejected requests in requests.jsonl, appends the full disposition
  // audit log, and keeps decisions.json as a bounded recent window for prompts/dashboard.
  // Workers never write this file directly; new staged requests are consolidated before
  // arbitration, and status updates are serialized through updateJSONL.
  // Crash-atomic resolution: flip the matching requests.jsonl entries OUT of
  // 'pending' first, then write the decision audit. The orchestrator's restart
  // invariant for "should this be re-arbitrated?" is `request.status === 'pending'`,
  // so the only acceptable failure mode for a partial write is a missing audit
  // entry — never a re-arbitration of an already-decided request. The previous
  // order (audit first, flip second) allowed exactly that re-arbitration:
  // decisions.jsonl claimed the request was resolved while requests.jsonl still
  // showed it pending, and the next loop tick double-decided.
  function processApprovals(response, paths, log, { pending = [] } = {}) {
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
    appendDecisionRecords(paths, decisionsToAdd, log);

    resetMilestonesOnWaitResolutions(response, pending, paths, log);
  }

  // Single-use helper — called from processApprovals above. A progress_timeout
  // request that is approved without a soft/hard restart action targeting the
  // same agent counts as a "wait" resolution: the orchestrator chose to let
  // the agent continue. Treat that as a milestone so subsequent stalls don't
  // immediately escalate based on the stale history.
  function resetMilestonesOnWaitResolutions(response, pending, paths, log) {
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

  function appendDecisionRecords(paths, decisionsToAdd, log) {
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

  function markCompletionRequestsValidating(paths, agentName, requestIds) {
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

  function resolveCompletionRequestsAfterValidationFailure(paths, agentName, requests, validationLog, log) {
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
    appendDecisionRecords(paths, decisionsToAdd, log);
  }

  function rejectCompletionRequestsForAgent(arbitration, paths, agentName, reason, log) {
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
    appendDecisionRecords(paths, decisionsToAdd, log);
  }

  // Resolves the agent's pending completion approval and then immediately marks
  // the agent COMPLETED. The two writes are issued back-to-back with nothing
  // between them, so the invariant "status=completed ⇒ approval resolved" holds
  // even if the orchestrator crashes mid-flow.
  function finalizeEndAgentCompletion(action, arbitration, paths, log) {
    resolveEndAgentApprovalBeforeSignal(action, arbitration, paths, log);
    updateJSON(paths.agents, (agents) => {
      if (!agents[action.agent]) return;
      transitionAgentStatus(agents[action.agent], action.agent, STATUS.COMPLETED, "validation passed, agent ended", log);
    });
  }

  function resolveEndAgentApprovalBeforeSignal(action, arbitration, paths, log) {
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
    appendDecisionRecords(paths, decisionsToAdd, log);
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
}

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    coordDir: "./coord",
    maxRetries: 3,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--coord") config.coordDir = args[++i];
    if (args[i] === "--poll-interval") config.fixedPollIntervalMs = parseInt(args[++i], 10);
  }
  // Derive the log path from --coord so a non-default coord directory keeps its
  // own orchestrator.log instead of writing to (or ENOENT-ing on) ./coord.
  config.logFile = path.join(config.coordDir, "orchestrator.log");
  return config;
}

function getPaths(coordDir) {
  return {
    requests: path.join(coordDir, "requests.jsonl"),
    requestsDir: path.join(coordDir, "requests"),
    decisions: path.join(coordDir, "decisions.json"),
    decisionsAudit: path.join(coordDir, "decisions.jsonl"),
    decisionsMd: path.join(coordDir, "DECISIONS.md"),
    callerContextMd: path.join(coordDir, "CALLER_CONTEXT.md"),
    context: path.join(coordDir, "context.json"),
    agents: path.join(coordDir, "agents.json"),
    progressDir: path.join(coordDir, "progress"),
  };
}

function ensureDecisionAuditLog(paths, log) {
  if (fs.existsSync(paths.decisionsAudit)) return;

  let recentDecisions = [];
  try {
    recentDecisions = readJSON(paths.decisions);
  } catch {}

  if (recentDecisions.length > 0) {
    appendJSONL(paths.decisionsAudit, recentDecisions);
    log(`Initialized decisions.jsonl from ${recentDecisions.length} existing recent decisions.`);
  } else {
    fs.writeFileSync(paths.decisionsAudit, "");
    log("Initialized empty decisions.jsonl audit log.");
  }
}

// Filters out decisions from prior runs so a `--resume` (or non-`--force` rerun)
// doesn't bleed stale arbitration history into the new run's prompts. Entries
// without a run_id are treated as "pre-run_id" and excluded by the same logic —
// any decision the orchestrator wants to surface to arbitration in this run
// must have been stamped by appendDecisionRecords in this run.
function readRecentDecisions(decisionsPath, currentRunId) {
  const decisions = readJSON(decisionsPath);
  if (!Array.isArray(decisions)) return [];
  const filtered = currentRunId
    ? decisions.filter((d) => d && d.run_id === currentRunId)
    : decisions;
  return filtered.slice(-RECENT_DECISION_LIMIT);
}

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

function readTaskContext(contextPath, agentName) {
  try {
    const context = readJSON(contextPath);
    return context.tasks?.[agentName] || null;
  } catch {
    return null;
  }
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

function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function inspectAbortFlag(abortFlagPath, runStartedAt) {
  if (!fs.existsSync(abortFlagPath)) return { active: false, stale: false };

  let stat;
  try {
    stat = fs.statSync(abortFlagPath);
  } catch {
    return { active: false, stale: false };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(abortFlagPath, "utf-8"));
  } catch {}

  const pid = parsed && Number.isInteger(Number(parsed.pid)) && Number(parsed.pid) > 0
    ? Number(parsed.pid)
    : null;
  let writtenAt = parsed && typeof parsed.written_at === "string" ? parsed.written_at : "";
  let writtenMs = Date.parse(writtenAt);
  const hasJsonWrittenAt = Number.isFinite(writtenMs);
  if (!hasJsonWrittenAt) {
    writtenMs = stat.mtimeMs;
    writtenAt = new Date(stat.mtimeMs).toISOString();
  }

  const runStartedMs = Date.parse(runStartedAt);
  const stale = Number.isFinite(runStartedMs) && Number.isFinite(writtenMs) && (
    hasJsonWrittenAt
      ? writtenMs < runStartedMs
      : writtenMs + LEGACY_ABORT_FLAG_STARTUP_GRACE_MS < runStartedMs
  );
  return {
    active: !stale,
    stale,
    pid,
    writtenAt,
  };
}

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

function readJSONIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// ─── IO helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(logFile, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, line);
  if (process.stdout.isTTY !== false) console.log(line.trim());
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScriptTerminal(command) {
  const script = `tell application "Terminal" to do script "${appleScriptString(command)}"`;
  const result = spawnSync("osascript", ["-e", script], { encoding: "utf-8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(details || `osascript exited with status ${result.status}`);
  }
}

function shouldAutoLaunchDashboard(setting) {
  if (setting === false) {
    return { launch: false, reason: "Dashboard auto-launch disabled" };
  }
  if (setting === true) {
    return { launch: true, reason: "Dashboard auto-launch enabled" };
  }
  if (setting !== "auto") {
    return { launch: false, reason: "Dashboard auto-launch disabled" };
  }
  if (process.platform !== "darwin") {
    return { launch: false, reason: "Dashboard auto-launch auto mode skipped on non-macOS" };
  }
  if (process.env.CI) {
    return { launch: false, reason: "Dashboard auto-launch auto mode skipped in CI" };
  }
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
    return { launch: false, reason: "Dashboard auto-launch auto mode skipped over SSH" };
  }
  return { launch: true, reason: "Dashboard auto-launch auto mode enabled on macOS" };
}

function formatInstanceLockError(err) {
  const coordDir = err.coordDir || "(unknown coord)";
  const pidText = err.pid ? ` (PID ${err.pid})` : "";
  const base = [
    `Another orchestrator loop is already running on '${coordDir}'${pidText}.`,
    "Refusing to start a second instance - concurrent loops would double-arbitrate pending requests and double-bump restart counts on the same agents.",
  ];
  if (err.detectedVia === "ps" && err.cmd) {
    base.push("");
    base.push(`Detected via ps scan: ${err.cmd}`);
    base.push("");
    base.push(`If that process is wedged, stop it explicitly (e.g. \`kill ${err.pid}\`) before retrying.`);
  } else {
    const marker = err.lockMarker || path.join(coordDir, "orchestrator.instance.lock");
    base.push("");
    base.push("Detected via singleton lock marker.");
    base.push("");
    base.push(`If you're certain no other loop is running (e.g. it crashed without cleanup), remove the stale lock marker:  rm -rf '${marker}'`);
  }
  return base.join("\n");
}

// ─── Process / git helpers ───────────────────────────────────────────────────

function isAgentProcessAlive(agent, parsedConfig, cmdMap) {
  return pidMatchesCli(agent?.pid, expectedProcessForAgent(agent, parsedConfig), { recordedCmdline: agent?.spawned_cmdline, cmdMap });
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

function killTimedOutChild(pid) {
  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  }, 2000).unref?.();
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

// Thin wrapper around lib/log-tail.tailLines. Workers emit stream-json that
// can balloon to hundreds of MB on long runs; we never want to slurp the whole
// file just to grab the trailing 50 lines.
function readTail(filePath, lines) {
  return tailLines(filePath, lines);
}

// Returns the agent's current-process start time in ms. When every stored
// timestamp is missing or unparseable we return 0 (epoch) rather than Date.now():
// resetting the clock to "now" every cycle makes a wedged agent immortal. An
// epoch start trips the liveness-timeout branch, which parks the agent for a
// human instead of treating it as freshly spawned.
function readAgentCurrentStartMs(agent, { name, log } = {}) {
  const raw = agent.current_started_at || agent.last_spawned_at || agent.started_at;
  const parsed = raw ? new Date(raw).getTime() : NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (typeof log === "function") {
    log(`Agent ${name || "(unknown)"}: unparseable liveness timestamp (${JSON.stringify(raw)}); treating as stale (needs attention) rather than newly-started.`);
  }
  return 0;
}

function collectWorktreeStates(pending, agents) {
  const states = {};
  for (const req of pending) {
    if (states[req.agent] || !agents[req.agent]) continue;
    const worktree = agents[req.agent].worktree;
    if (!fs.existsSync(worktree)) continue;
    try {
      const status = gitStdout(worktree, ["status", "-s"]);
      const baseBranch = agents[req.agent].base_ref || "main";

      const diffStatUnstaged = gitStdout(worktree, ["diff", "--stat"]);
      const diffStatStaged = gitStdout(worktree, ["diff", "--staged", "--stat"]);
      const diffStatBranch = gitStdout(worktree, ["diff", `${baseBranch}...HEAD`, "--stat"]);

      let targetedDiffs = "";
      try {
        const filesChanged = gitStdout(worktree, ["diff", `${baseBranch}...HEAD`, "--name-only"]).split("\n").filter(Boolean);
        for (const file of filesChanged) {
          if (req.content.includes(file) || req.content.includes(path.basename(file))) {
            const fileDiff = gitStdout(worktree, ["diff", `${baseBranch}...HEAD`, "--", file]);
            targetedDiffs += `\nFull diff for ${file}:\n${fileDiff.slice(0, 3000)}`;
          }
        }
      } catch {}

      states[req.agent] = `STATUS:\n${status}\n\nCHANGES (UNSTAGED):\n${diffStatUnstaged}\nCHANGES (STAGED):\n${diffStatStaged}\nCHANGES (COMMITS against ${baseBranch}):\n${diffStatBranch}${targetedDiffs ? "\n\nTARGETED DIFFS:\n" + targetedDiffs : ""}`;
    } catch (err) {
      states[req.agent] = `Failed to read worktree state: ${err.message}`;
    }
  }
  return states;
}

// ─── Orchestrator CLI invocation ─────────────────────────────────────────────

// Cap-aware wrapper around buildOrchestratorPrompt. Smaller-context arbitration
// CLIs silently degrade once their input drifts past ~30 KB, so when several
// stalled agents each contribute a 50-line log tail + diff snapshot we compact
// per-request content (and worktree state blobs) before re-rendering. The first
// render is still attempted at full fidelity; only blobs are truncated on
// overflow, never structural fields like request_id / type.
const ARBITRATION_PROMPT_CAP_BYTES = 32 * 1024;
const ARBITRATION_PER_REQUEST_CAP_BYTES = 4 * 1024;
const ARBITRATION_PER_STATE_CAP_BYTES = 2 * 1024;

function buildBoundedArbitrationPrompt({ pending, context, durableDecisions, recentDecisions, worktreeStates, callerContext, log }) {
  const fullPrompt = buildOrchestratorPrompt(pending, context, durableDecisions, recentDecisions, worktreeStates, callerContext);
  if (Buffer.byteLength(fullPrompt, "utf-8") <= ARBITRATION_PROMPT_CAP_BYTES) return fullPrompt;

  const compactedPending = pending.map((req) => {
    if (!req || typeof req.content !== "string") return req;
    return { ...req, content: truncateMiddle(req.content, ARBITRATION_PER_REQUEST_CAP_BYTES) };
  });
  const compactedStates = {};
  for (const [agent, state] of Object.entries(worktreeStates || {})) {
    compactedStates[agent] = typeof state === "string"
      ? truncateMiddle(state, ARBITRATION_PER_STATE_CAP_BYTES)
      : state;
  }

  const compactPrompt = buildOrchestratorPrompt(compactedPending, context, durableDecisions, recentDecisions, compactedStates, callerContext);
  const originalKb = (Buffer.byteLength(fullPrompt, "utf-8") / 1024).toFixed(1);
  const cappedKb = (Buffer.byteLength(compactPrompt, "utf-8") / 1024).toFixed(1);
  log?.(`Arbitration prompt exceeded ${(ARBITRATION_PROMPT_CAP_BYTES / 1024).toFixed(0)} KB (was ${originalKb} KB) — compacted per-request and worktree-state blobs to ${cappedKb} KB.`);
  return compactPrompt;
}

// Keeps the head and tail of a long blob and inserts a marker between them.
// Useful for log tails + diff snapshots where both early structure (headers)
// and recent content (most recent log lines / diff endings) carry signal.
function truncateMiddle(text, maxBytes) {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  const marker = `\n[...truncated ${buf.length - maxBytes} bytes...]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  if (maxBytes <= markerBytes) return marker.trim();
  const keep = maxBytes - markerBytes;
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  return `${buf.slice(0, head).toString("utf-8")}${marker}${buf.slice(buf.length - tail).toString("utf-8")}`;
}

// Builds the arbitration prompt sent to the orchestrator CLI for each pending-request cycle.
function buildOrchestratorPrompt(requests, context, durableDecisions, decisions, worktreeStates, callerContext = "") {
  return `You are the system orchestrator for a multi-agent project.

Worker agents are running as headless CLI sessions, each in an isolated git worktree.
They submit requests by atomically writing JSON files into coord/requests/.
The loop consolidates those files into coord/requests.jsonl for arbitration.

## Responsibilities
- Maintain consistency across all agent sessions
- Resolve requests without contradicting existing decisions
- Prevent conflicts between agents working in parallel worktrees
- Prefer minimal disruption to running sessions
- Reject unclear requests — ask for clarification rather than guessing
- Treat \`progress_timeout\` requests as loop-generated diagnostics for agents that are alive but making no git-visible progress; choose whether to \`soft_restart\`, \`hard_restart\`, wait, or reject for manual inspection based on the request context.
- For \`progress_timeout\` requests, consider \`escalation_level\`, \`suggested_action\`, \`progress_timeout_count\`, \`restart_count\`, \`restarts_remaining\`, and any progress heartbeat before choosing an action.
- Every request you process MUST be explicitly included in either the \`approved\` or \`rejected\` array. Even if you issue an action like \`end_agent\`, you MUST STILL approve the request that triggered it so it is marked as resolved.

## Response Format
Return ONLY valid JSON matching this exact structure (no markdown, no explanation):
{
  "approved": [
    { "request_id": "...", "decision": "clear statement of what was decided", "reason": "why this decision was made" }
  ],
  "rejected": [
    { "request_id": "...", "reason": "why this was rejected" }
  ],
  "actions": [
    { "type": "end_agent | soft_restart | hard_restart", "agent": "agent-name", "instruction": "optional — new instructions for the session" }
  ]
}

## Dynamic Inputs

## Compact Project Context
${JSON.stringify(context, null, 2)}

## Durable Project Decisions from coord/DECISIONS.md (DO NOT contradict these)
${durableDecisions.trim() || "(none recorded)"}

## Caller Session Context from coord/CALLER_CONTEXT.md
${callerContext.trim() || "(none recorded)"}

## Recent Runtime Decisions (DO NOT contradict these)
${JSON.stringify(decisions, null, 2)}

## Agent Worktree States (Code Context)
Here is the current git status and diff for the agents that submitted requests. Use this code context to understand their progress and evaluate their requests:
${JSON.stringify(worktreeStates, null, 2)}

## New Requests from Agents
${JSON.stringify(requests, null, 2)}

## Your Responsibilities
Apply the responsibilities and response format above to these new requests.
`;
}

// Calls the orchestrator CLI for arbitration. Honors `orchestrator_cli` + `cli_templates`
// in orchestrator config so monitoring runs through a configurable (often cheap) model.
async function callOrchestratorCli(prompt, parsedConfig, maxRetries, log, abortFlagPath) {
  const cli = parsedConfig.orchestrator_cli;
  const template = parsedConfig.cli_templates[cli];
  const timeoutMs = parsedConfig.orchestrator_cli_timeout_ms;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const mode = template ? cliTemplateMode(template) : "missing-template";
    log(`Calling orchestrator CLI '${cli}' via ${mode} mode (attempt ${attempt}/${maxRetries}, timeout ${timeoutMs}ms)...`);
    const { stdout, error } = await invokeOrchestratorCli(cli, template, prompt, timeoutMs);
    if (abortFlagPath && fs.existsSync(abortFlagPath)) {
      log(`Orchestrator CLI call aborted via flag.`);
      return null;
    }
    if (error) {
      log(`Orchestrator CLI failed: ${error}`);
      if (attempt === maxRetries) return null;
      continue;
    }
    const parsed = extractJsonObject(stdout);
    if (!parsed) {
      log(`No JSON object in CLI output (attempt ${attempt}).`);
      if (attempt === maxRetries) return null;
      continue;
    }
    log(`Orchestrator CLI call succeeded.`);
    return parsed;
  }
  return null;

  // Single-use helper — only called from the retry loop above.
  function invokeOrchestratorCli(cli, template, prompt, timeoutMs) {
    if (!template) {
      return Promise.resolve({ stdout: "", error: `No cli_templates.${cli} configured for orchestrator_cli.` });
    }

    const promptFile = path.join(os.tmpdir(), `orch-prompt-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt, "utf-8");

    return new Promise((resolve) => {
      let child;
      let settled = false;
      let stdout = "";
      let stderr = "";
      const maxBuffer = 1024 * 1024 * 10;

      let abortWatcher = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { abortWatcher?.close(); } catch {}
        try { fs.unlinkSync(promptFile); } catch {}
        resolve(value);
      };

      // Watch for abort.flag while the CLI runs so Ctrl+C (which writes the
      // flag) cancels the in-flight subprocess promptly instead of feeling
      // unresponsive for up to timeoutMs. The top-of-loop handler then runs
      // the real abort path on the next cycle.
      if (abortFlagPath) {
        const watchAbort = () => {
          if (settled || !fs.existsSync(abortFlagPath)) return;
          const pid = child?.pid;
          if (pid) {
            log(`Abort flag detected; cancelling in-flight orchestrator CLI (PID ${pid}).`);
            killTimedOutChild(pid);
          }
          try { child?.stdout?.destroy(); } catch {}
          try { child?.stderr?.destroy(); } catch {}
          finish({ stdout, error: "Aborted by abort.flag" });
        };
        try {
          abortWatcher = fs.watch(path.dirname(abortFlagPath), (_event, filename) => {
            if (!filename || filename === path.basename(abortFlagPath)) watchAbort();
          });
        } catch {}
        watchAbort(); // Catch a flag written before the watch was armed.
      }

      const timeout = setTimeout(() => {
        const pid = child?.pid;
        if (pid) {
          log(`Orchestrator CLI '${cli}' timed out after ${timeoutMs}ms; terminating PID ${pid}.`);
          killTimedOutChild(pid);
        }
        try { child?.stdout?.destroy(); } catch {}
        try { child?.stderr?.destroy(); } catch {}
        try { child?.unref?.(); } catch {}
        finish({ stdout, error: `Timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      try {
        child = spawnCliTemplate(cli, template, {
          promptFile,
          promptText: prompt,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        finish({ stdout: "", error: err.message });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        if (stdout.length < maxBuffer) stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < maxBuffer) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => {
        finish({ stdout, error: err.message });
      });
      child.on("close", (status, signal) => {
        if (status === 0) {
          finish({ stdout });
          return;
        }
        const suffix = stderr ? `: ${stderr}` : "";
        const exit = signal ? `Signal ${signal}` : `Exit ${status}`;
        finish({ stdout, error: `${exit}${suffix}` });
      });
    });
  }
}

// ─── Stalled-flag handling ───────────────────────────────────────────────────

function writeStalledFlag(coordDir, consecutiveFailures, pending, parsedConfig, log) {
  const stalledFlag = path.join(coordDir, "orchestrator-stalled.flag");
  const high = pending.filter((p) => p.priority === "high").length;
  const info = {
    timestamp: new Date().toISOString(),
    consecutive_failures: consecutiveFailures,
    pending_requests: pending.length,
    high_priority_requests: high,
    orchestrator_cli: parsedConfig.orchestrator_cli,
    message: `Orchestrator CLI '${parsedConfig.orchestrator_cli}' has failed ${consecutiveFailures} cycles in a row. ${high} high-priority request(s) blocked.`,
  };
  try {
    fs.writeFileSync(stalledFlag, JSON.stringify(info, null, 2));
    log(`Wrote stalled flag (${stalledFlag}). Dashboard will surface this until the CLI recovers.`);
  } catch (err) {
    log(`Failed to write stalled flag: ${err.message}`);
  }
}

function clearStalledFlag(coordDir, log) {
  const stalledFlag = path.join(coordDir, "orchestrator-stalled.flag");
  if (fs.existsSync(stalledFlag)) {
    try {
      const info = JSON.parse(fs.readFileSync(stalledFlag, "utf-8"));
      appendEvent(coordDir, "orchestrator_cli_stalled_cleared", { data: info });
      fs.unlinkSync(stalledFlag);
      log("Cleared stalled flag — orchestrator CLI recovered.");
    } catch {}
  }
}

// ─── Final summary phase ─────────────────────────────────────────────────────

function finalize(config, paths, parsedConfig, log) {
  const agents = readJSON(paths.agents);
  const requests = readJSONL(paths.requests);
  let tasks = {};
  try {
    tasks = readJSON(paths.context).tasks || {};
  } catch {}
  const summaryFile = path.join(config.coordDir, "review-summary.txt");
  const summaryOutput = buildFinalSummary(agents, requests, tasks);
  fs.writeFileSync(summaryFile, summaryOutput, "utf-8");

  // Deliberately excludes needs_attention: a parked agent is awaiting a human,
  // not failed/vanished, so it must not flip the run to the "incomplete" copy.
  const failedCount = Object.values(agents).filter((agent) => agent.status === "exited" || agent.status === "errored").length;
  const parkedCount = Object.values(agents).filter((agent) => agent.status === STATUS.NEEDS_ATTENTION).length;
  if (failedCount > 0) {
    log(`Run ended incomplete (${failedCount} agents failed/vanished). Deterministic summary written to ${path.resolve(summaryFile)}.`);
  } else if (parkedCount > 0) {
    log(`Run paused for review (${parkedCount} agents awaiting human intervention). Deterministic summary written to ${path.resolve(summaryFile)}.`);
  } else {
    log(`All worker agents completed. Deterministic summary written to ${path.resolve(summaryFile)}.`);
  }

  try {
    if (!parsedConfig.launch_review_terminal) {
      log(`Review terminal auto-launch disabled. Summary written to ${path.resolve(summaryFile)}.`);
      console.log("\n" + summaryOutput + "\n");
      log("Orchestrator loop ending.");
      return;
    }
    if (process.platform === "darwin") {
      const command = `cat ${shellQuote(path.resolve(summaryFile))}; echo; echo 'Press any key to close...'; read -n 1`;
      runAppleScriptTerminal(command);
    } else if (process.platform === "win32") {
      runSummaryTerminal("cmd.exe", ["/c", "start", "cmd", "/k", "type", path.resolve(summaryFile)]);
    } else {
      const summaryPath = path.resolve(summaryFile);
      try {
        runSummaryTerminal("x-terminal-emulator", ["-e", "sh", "-c", "cat \"$1\"; printf '\\nPress Enter to close...'; read _", "summary-view", summaryPath]);
      } catch {
        runSummaryTerminal("xterm", ["-e", "sh", "-c", "cat \"$1\"; printf '\\nPress Enter to close...'; read _", "summary-view", summaryPath]);
      }
    }
    log("Opened review summary in new terminal window.");
  } catch (err) {
    log(`Could not open new terminal: ${err.message}. Printing summary inline.`);
    console.log("\n" + summaryOutput + "\n");
  }
  log("Orchestrator loop ending.");
}

function runSummaryTerminal(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(details || `${cmd} exited with status ${result.status}`);
  }
}

function buildFinalSummary(agents = {}, requests = [], tasks = {}) {
  const names = Object.keys(agents).sort();
  // This filter drives task-succeeded semantics (the RUN INCOMPLETE title and
  // the failed-agents list), not loop-can-exit semantics — so needs_attention
  // is excluded here even though the all-done gate treats it as terminal. A
  // parked agent is neither a success nor a failure; it is pending a human.
  const failedAgents = names.filter((name) => {
    const status = agents[name]?.status;
    return status === "exited" || status === "errored";
  });
  // Tri-state, independent of failedAgents semantics: a parked agent is neither
  // a success nor a failure, but the run is not "all completed" while a human
  // still has to step in.
  const parkedAgents = names.filter((name) => agents[name]?.status === STATUS.NEEDS_ATTENTION);
  const title = failedAgents.length > 0
    ? "RUN INCOMPLETE"
    : parkedAgents.length > 0
      ? "AWAITING REVIEW"
      : "ALL AGENTS COMPLETED";
  const lines = [
    title,
    "",
    "Deterministic summary generated from agents.json and worker review requests. No final AI summary call was run.",
    "",
  ];

  if (failedAgents.length > 0) {
    lines.push("Some agents failed or vanished before completing their work:");
    for (const name of failedAgents) {
      const agent = agents[name];
      const description = tasks[name]?.description || agent.task || "Initial prompt";
      lines.push(`- ${name} (${agent.status}): ${truncate(description, 120)}`);
    }
    lines.push("");
  }

  if (parkedAgents.length > 0) {
    lines.push("Some agents are parked awaiting human intervention:");
    for (const name of parkedAgents) {
      const agent = agents[name];
      lines.push(`- ${name}: ${truncate(agent.attention_reason || "(no reason recorded)", 120)}`);
    }
    lines.push("");
  }

  lines.push("Agents:");
  if (names.length === 0) {
    lines.push("- (none)");
  }
  for (const name of names) {
    const agent = agents[name] || {};
    const reviewRequest = latestReviewRequestForAgent(requests, name);
    lines.push(`- ${name}`);
    lines.push(`  Status: ${agent.status || "(unknown)"}`);
    lines.push(`  Branch: ${name}`);
    lines.push(`  Worktree: ${agent.worktree || "(unknown)"}`);
    lines.push(`  Lifecycle started: ${agent.started_at || "(unknown)"}`);
    if ((agent.current_started_at || agent.last_spawned_at) && (agent.current_started_at || agent.last_spawned_at) !== agent.started_at) {
      lines.push(`  Current process started: ${agent.current_started_at || agent.last_spawned_at}`);
    }
    lines.push(`  Task: ${truncate(tasks[name]?.description || agent.task || "Initial prompt", 180)}`);
    if (agent.last_instruction) {
      lines.push(`  Last restart instruction: ${truncate(agent.last_instruction, 180)}`);
    }
    lines.push(`  Validation: ${agent.status === STATUS.COMPLETED ? "passed before completion" : "not confirmed"}`);
    lines.push(`  Worker report: ${reviewRequest ? truncate(reviewRequest.content || "(empty)", 500) : "(no review_request recorded)"}`);
  }

  lines.push("");
  lines.push("Next:");
  if (failedAgents.length > 0) {
    lines.push("- Inspect failed worktrees and logs before merging.");
  } else {
    lines.push("- Return to the interactive caller session to inspect diffs, run final checks, merge approved branches, and remove worktrees.");
  }
  return `${lines.join("\n")}\n`;
}

function latestReviewRequestForAgent(requests, agentName) {
  for (let i = requests.length - 1; i >= 0; i--) {
    const request = requests[i];
    if (request && request.agent === agentName && request.type === "review_request") {
      return request;
    }
  }
  return null;
}

function truncate(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

module.exports = {
  buildOrchestratorPrompt,
  buildBoundedArbitrationPrompt,
  ARBITRATION_PROMPT_CAP_BYTES,
  buildFinalSummary,
  captureRecoveryAndReset,
  checkCompletionOwnership,
  collectOwnershipChangedFiles,
  commitWorktree,
  pathPatternMatches,
  stageAllChanges,
  readAgentCurrentStartMs,
  consolidateStagedRequests,
  getPaths,
  progressTimeoutHistory,
  sweepRestartPrompts,
};
