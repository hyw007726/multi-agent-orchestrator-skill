#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawnSync } = require("child_process");
const { loadConfig } = require("./lib/config");
const { safeKill } = require("./lib/process");
const { acquireInstanceLock, readJSON, readJSONL, updateJSON, updateJSONL, appendJSONL } = require("./lib/locking");
const { renderWorkerPrompt, renderWorkerRestartPrompt } = require("./lib/prompt-render");
const { STATUS, transitionAgentStatus } = require("./lib/status");
const { appendEvent } = require("./lib/events");
const { cliTemplateMode, spawnCliTemplateSync } = require("./lib/cli-template");

const RECENT_DECISION_LIMIT = 30;

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
  const instanceLock = acquireInstanceLock(config.coordDir);
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
  log(`Acquired singleton lock on ${instanceLock.markerPath} (PID ${process.pid}).`);
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
      if (fs.existsSync(path.join(config.coordDir, "abort.flag"))) {
        log("ABORT SIGNAL RECEIVED. Stopping running agents (worktrees preserved)...");
        const toKill = [];
        appendEvent(config.coordDir, "abort_requested", { reason: "abort.flag detected" });
        updateJSON(paths.agents, (agents) => {
          for (const name in agents) {
            if (agents[name].status === "running") {
              toKill.push({ pid: agents[name].pid, cli: agents[name].cli || "kilo", name });
              transitionAgentStatus(agents[name], name, STATUS.TERMINATED, "abort signal", log);
            }
          }
        });
        // Kill outside the lock — the lock's job is to protect agents.json, not gate signals.
        for (const { pid, cli, name } of toKill) safeKill({ pid, expectedCli: cli, log, coordDir: config.coordDir, agent: name });
        log("All running agents stopped. Worktree contents preserved (run `git status` in each worktree to inspect/discard).");
        try { fs.unlinkSync(path.join(config.coordDir, "abort.flag")); } catch {}
        aborted = true;
        break;
      }

      // ── Per-agent liveness + progress checks ─────────────────────────────
      // Snapshot read for diagnostics; each actual mutation takes its own lock.
      const snapshot = readJSON(paths.agents);
      const allRequests = readJSONL(paths.requests);

      for (const name in snapshot) {
        if (snapshot[name].status !== "running") continue;
        const agent = snapshot[name];

        // Process gone? Check whether the agent requested completion first.
        if (!isProcessAlive(agent.pid)) {
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
        let lastActivity = new Date(agent.started_at).getTime();
        if (fs.existsSync(logFile)) lastActivity = fs.statSync(logFile).mtime.getTime();

        const timeoutMins = agent.timeout_mins || parsedConfig.default_timeout_mins;
        if (Date.now() - lastActivity > timeoutMins * 60 * 1000) {
          log(`Agent ${name} idle (no log output) for ${timeoutMins} mins. Killing.`);
          safeKill({ pid: agent.pid, expectedCli: agent.cli || "kilo", log, coordDir: config.coordDir, agent: name });
          updateJSON(paths.agents, (agents) => {
            if (agents[name] && agents[name].status === "running") {
              transitionAgentStatus(agents[name], name, STATUS.ERRORED, `liveness timeout - idle ${timeoutMins} mins`, log);
            }
          });
          continue;
        }

        // Progress ("Reviewer") timeout: log output present but no code change.
        const progressMins = agent.progress_timeout_mins || parsedConfig.default_progress_timeout_mins;
        const currentDiff = readDiffSnapshot(agent.worktree);
        const tracker = agentProgress[name];
        if (!tracker) {
          agentProgress[name] = { last_diff: currentDiff, last_progress_time: Date.now() };
        } else if (tracker.last_diff !== currentDiff) {
          tracker.last_diff = currentDiff;
          tracker.last_progress_time = Date.now();
        } else if (Date.now() - tracker.last_progress_time > progressMins * 60 * 1000) {
          log(`Agent ${name} stuck for ${progressMins} mins (no code changes). Triggering AI Review.`);
          const tailLines = readTail(logFile, 50);
          const reviewInstruction = generateAiReviewInstruction(tailLines, parsedConfig, log);
          log(`AI Review fix: ${reviewInstruction}`);

          const restarted = bumpRestartAndRespawn({
            name,
            instruction: reviewInstruction,
            reason: "progress timeout",
            paths,
            parsedConfig,
            mode: "soft",
            log,
          });
          if (restarted) tracker.last_progress_time = Date.now();
          continue;
        }
      }

      // ── Pending requests / arbitration ───────────────────────────────────
      const pending = allRequests.filter((p) => p.status === "pending");

      if (pending.length > 0) {
        cycleHadPending = true;
        log(`Found ${pending.length} pending requests.`);
        const context = readJSON(paths.context);
        const durableDecisions = readTextIfExists(paths.decisionsMd);
        const recentDecisions = readRecentDecisions(paths.decisions);
        const agentsForPrompt = readJSON(paths.agents);

        const worktreeStates = collectWorktreeStates(pending, agentsForPrompt);
        const prompt = buildOrchestratorPrompt(pending, context, durableDecisions, recentDecisions, worktreeStates);
        const response = callOrchestratorCli(prompt, parsedConfig, config.maxRetries, log);

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
          processActions(response.actions || [], paths, parsedConfig, log);
          processApprovals(response, paths, log);
        }
      } else {
        // ── All-done check ────────────────────────────────────────────────
        const agents = readJSON(paths.agents);
        const entries = Object.values(agents);
        const allDone = entries.length > 0 &&
          entries.every((a) => a.status === "completed" || a.status === "terminated" || a.status === "errored" || a.status === "exited");
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
    log("Cleaning up coordination directory (worktrees preserved).");
    try { fs.rmSync(config.coordDir, { recursive: true, force: true }); } catch {}
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

  function processActions(actions, paths, parsedConfig, log) {
    for (const rawAction of actions) {
      // restart_agent is a legacy alias for soft_restart.
      const action = rawAction.type === "restart_agent" ? { ...rawAction, type: "soft_restart" } : rawAction;

      if (action.type === "end_agent") {
        const snapshot = readJSON(paths.agents)[action.agent];
        if (!snapshot) continue;

        const validation = runValidation(snapshot, log);
        if (validation.passed) {
          // Auto-commit any uncommitted changes so the final merge phase picks them up.
          const worktree = snapshot.worktree;
          if (fs.existsSync(worktree)) {
            try {
              execSync(`git add -A`, { cwd: worktree, stdio: "ignore" });
              try {
                const taskSummary = (snapshot.task || "completed").toString().slice(0, 200);
                execSync(`git commit -m "agent-${action.agent}: ${taskSummary}"`, { cwd: worktree, stdio: "ignore" });
                log(`Agent ${action.agent}: auto-committed worktree state.`);
              } catch {
                log(`Agent ${action.agent}: no changes to commit (already clean).`);
              }
            } catch (err) {
              log(`Agent ${action.agent}: auto-commit failed: ${err.message}`);
            }
          }

          safeKill({ pid: snapshot.pid, expectedCli: snapshot.cli || "kilo", log, coordDir: config.coordDir, agent: action.agent });
          updateJSON(paths.agents, (agents) => {
            if (!agents[action.agent]) return;
            transitionAgentStatus(agents[action.agent], action.agent, STATUS.COMPLETED, "validation passed, agent ended", log);
          });
          appendEvent(config.coordDir, "agent_completed", { agent: action.agent });
        } else {
          log(`Validation failed for ${action.agent} — converting to soft_restart.`);
          appendEvent(config.coordDir, "validation_failed", { agent: action.agent, reason: validation.log.slice(0, 500) });
          bumpRestartAndRespawn({
            name: action.agent,
            instruction: `Validation failed! Please fix the errors:\n\n${validation.log}`,
            reason: "validation failure",
            paths,
            parsedConfig,
            mode: "soft",
            log,
          });
        }
        continue;
      }

      if (action.type === "soft_restart" || action.type === "hard_restart") {
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

  // Shared — used by the progress-timeout handler above and by processActions.
  // Atomically updates the agent's restart_count / status in agents.json, then performs
  // the side effects (kill, recovery/WIP-commit, subprocess respawn) OUTSIDE the lock so
  // we never hold the lock across a subprocess (which would deadlock on spawn-agent's own
  // updateJSON write).
  function bumpRestartAndRespawn({ name, instruction, reason, paths, parsedConfig, mode, log }) {
    const outcomeRef = { value: { kind: "missing" } };

    updateJSON(paths.agents, (agents) => {
      const agent = agents[name];
      if (!agent) return;

      const cliTool = agent.cli || parsedConfig.default_cli;

      if (!instruction) {
        transitionAgentStatus(agent, name, STATUS.TERMINATED, "no follow-up instruction", log);
        outcomeRef.value = { kind: "terminated", pid: agent.pid, cliTool, worktree: agent.worktree };
        appendEvent(config.coordDir, "restart_aborted", { agent: name, reason: "no instruction" });
        return;
      }

      const nextCount = (agent.restart_count ?? 0) + 1;
      const maxRestarts = parsedConfig.default_max_restarts;
      if (nextCount > maxRestarts) {
        agent.task = `Exhausted ${maxRestarts} restart attempts (${reason}). Last instruction: ${instruction.slice(0, 200)}`;
        transitionAgentStatus(agent, name, STATUS.ERRORED, `max restarts (${maxRestarts}) exhausted`, log);
        outcomeRef.value = { kind: "errored", pid: agent.pid, cliTool, worktree: agent.worktree };
        appendEvent(config.coordDir, "restart_aborted", { agent: name, reason: `max restarts (${maxRestarts}) reached - ${reason}` });
        return;
      }

      agents[name].restart_count = nextCount;
      agents[name].task = instruction;
      outcomeRef.value = {
        kind: "respawn",
        pid: agent.pid,
        cliTool,
        worktree: agent.worktree,
        kiloMode: agent.kilo_mode,
        validateCmd: agent.validate_cmd,
        timeoutMins: agent.timeout_mins,
        progressTimeoutMins: agent.progress_timeout_mins,
        baseRef: agent.base_ref,
        attempt: nextCount,
      };
    });

    const outcome = outcomeRef.value;
    if (outcome.kind === "missing") return false;

    // Side effects below the lock — none of these should re-enter updateJSON on the same file.
    safeKill({ pid: outcome.pid, expectedCli: outcome.cliTool, log, coordDir: config.coordDir, agent: name });

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
        const recovery = captureRecoveryAndReset(outcome.worktree, name, log);
        if (recovery.error) {
          log(`Hard restart: recovery/reset failed — ${recovery.error}. Marking errored.`);
          updateJSON(paths.agents, (agents) => {
            if (agents[name]) {
              transitionAgentStatus(agents[name], name, STATUS.ERRORED, `hard restart recovery failed: ${recovery.error}`, log);
            }
          });
          appendEvent(config.coordDir, "restart_aborted", { agent: name, reason: `hard reset failed: ${recovery.error}` });
          return false;
        }
        if (recovery.tag) {
          log(`Hard restart: wiped worktree but preserved state at tag ${recovery.tag}.`);
          appendEvent(config.coordDir, "recovery_tag_created", { agent: name, data: { tag: recovery.tag } });
          updateJSON(paths.agents, (agents) => {
            if (agents[name]) agents[name].recovery_tag = recovery.tag;
          });
        } else {
          log(`Hard restart: worktree was already clean.`);
        }
      } else {
        try {
          execSync(`git add .`, { cwd: outcome.worktree });
          try {
            execSync(`git commit -m "WIP: orchestrator intervention (${reason})"`, { cwd: outcome.worktree, stdio: "ignore" });
          } catch {
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

    return respawnAgent({
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
      baseRef: outcome.baseRef,
      paths,
      log,
    });

    // Single-use helper — only called from bumpRestartAndRespawn above.
    function respawnAgent({ name, kiloMode, cliTool, attempt, maxAttempts, instruction, worktree, validateCmd, timeoutMins, progressTimeoutMins, baseRef, paths, log }) {
      const promptsDir = path.join(path.dirname(paths.agents), "prompts");
      fs.mkdirSync(promptsDir, { recursive: true });
      const promptFile = path.join(promptsDir, `restart-${name}-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, renderRestartPrompt({ name, instruction, worktree, paths, log }), "utf-8");
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

  function renderRestartPrompt({ name, instruction, worktree, paths, log }) {
    const contractPrompt = renderRestartContractPrompt({ name, worktree, paths, log });
    return renderWorkerRestartPrompt(instruction, contractPrompt);
  }

  function renderRestartContractPrompt({ name, worktree, paths, log }) {
    try {
      const context = readJSON(paths.context);
      const task = context.tasks?.[name];
      if (!task) return "";

      const templatePath = path.resolve(__dirname, "..", "references", "worker-prompt-template.md");
      const template = fs.readFileSync(templatePath, "utf-8");
      return renderWorkerPrompt(template, {
        ASSIGNED_TASK: task.description || "",
        PROJECT_DESCRIPTION: context.project || "",
        AGENT_NAME: name,
        WORKTREE_PATH: worktree || "",
        ALLOWED_PATHS_LIST: task.allowed_paths || [],
        FORBIDDEN_PATHS_LIST: task.forbidden_paths || [],
        READ_FIRST_LIST: task.read_first || task.relevant_files || [],
      });
    } catch (err) {
      log(`Restart prompt contract render failed for ${name}: ${err.message}`);
      return "";
    }
  }

  // Marks resolved/rejected requests in requests.jsonl, appends the full audit log,
  // and keeps decisions.json as a bounded recent window for prompts/dashboard.
  // Workers never write this file directly; new staged requests are consolidated before
  // arbitration, and status updates are serialized through updateJSONL.
  function processApprovals(response, paths, log) {
    const decisionsToAdd = [];
    const resolvedAt = new Date().toISOString();
    const currentRequests = readJSONL(paths.requests);
    const byId = new Map(currentRequests.map((request) => [request.request_id, request]));

    for (const approved of response.approved || []) {
      const req = byId.get(approved.request_id);
      if (!req || req.status !== "pending") continue;
      decisionsToAdd.push({
        request_id: approved.request_id,
        decision: approved.decision,
        reason: approved.reason,
        resolved_at: resolvedAt,
      });
    }

    if (decisionsToAdd.length > 0) {
      appendJSONL(paths.decisionsAudit, decisionsToAdd);
    }

    updateJSONL(paths.requests, (current) => {
      for (const approved of response.approved || []) {
        const req = current.find((p) => p.request_id === approved.request_id);
        if (req && req.status === "pending") {
          req.status = "resolved";
          log(`Approved Request ${approved.request_id}: ${approved.decision}`);
        }
      }
      for (const rejected of response.rejected || []) {
        const req = current.find((p) => p.request_id === rejected.request_id);
        if (req && req.status === "pending") {
          req.status = "rejected";
          log(`Rejected Request ${rejected.request_id}: ${rejected.reason}`);
        }
      }
    });

    if (decisionsToAdd.length === 0) return;

    updateJSON(paths.decisions, (decisions) => {
      decisions.push(...decisionsToAdd);
      if (decisions.length > RECENT_DECISION_LIMIT) {
        const archive = decisions.length - RECENT_DECISION_LIMIT;
        log(`Trimming ${archive} old decisions from decisions.json; full audit remains in decisions.jsonl.`);
        decisions.splice(0, archive);
      }
    });
  }
}

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    coordDir: "./coord",
    maxRetries: 3,
    logFile: "coord/orchestrator.log",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--coord") config.coordDir = args[++i];
    if (args[i] === "--poll-interval") config.fixedPollIntervalMs = parseInt(args[++i], 10);
  }
  return config;
}

function getPaths(coordDir) {
  return {
    requests: path.join(coordDir, "requests.jsonl"),
    requestsDir: path.join(coordDir, "requests"),
    decisions: path.join(coordDir, "decisions.json"),
    decisionsAudit: path.join(coordDir, "decisions.jsonl"),
    decisionsMd: path.join(coordDir, "DECISIONS.md"),
    context: path.join(coordDir, "context.json"),
    agents: path.join(coordDir, "agents.json"),
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

function readRecentDecisions(decisionsPath) {
  const decisions = readJSON(decisionsPath);
  if (!Array.isArray(decisions)) return [];
  return decisions.slice(-RECENT_DECISION_LIMIT);
}

function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// Shared — called at the very beginning of each runLoop cycle and from the
// vanished-worker check when a worker may have staged a request after the
// initial consolidation.
function consolidateStagedRequests(paths) {
  const requestsDir = paths.requestsDir;
  if (!fs.existsSync(requestsDir)) return;

  const entries = fs.readdirSync(requestsDir);
  const jsonFiles = entries.filter(f => f.endsWith(".json"));
  if (jsonFiles.length === 0) return;

  const collected = [];
  const consumedFiles = [];
  const malformedFiles = [];

  for (const file of jsonFiles) {
    const filePath = path.join(requestsDir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const obj = JSON.parse(raw);
      collected.push(obj);
      consumedFiles.push(filePath);
    } catch {
      malformedFiles.push(filePath);
    }
  }

  if (collected.length > 0) {
    updateJSONL(paths.requests, (current) => {
      current.push(...collected);
    });
    for (const filePath of consumedFiles) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  if (malformedFiles.length > 0) {
    const malformedDir = path.join(requestsDir, "malformed");
    fs.mkdirSync(malformedDir, { recursive: true });
    for (const filePath of malformedFiles) {
      const dest = path.join(malformedDir, path.basename(filePath));
      try {
        fs.renameSync(filePath, dest);
      } catch {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  }
}

// Shared — used by the vanished-worker check in runLoop.
// Reads all .json files from the staging directory and returns parsed objects
// WITHOUT moving/deleting them (that's consolidateStagedRequests's job).
function readStagedRequests(paths) {
  const requestsDir = paths.requestsDir;
  if (!fs.existsSync(requestsDir)) return [];

  const entries = fs.readdirSync(requestsDir);
  const jsonFiles = entries.filter(f => f.endsWith(".json"));
  if (jsonFiles.length === 0) return [];

  const out = [];
  for (const file of jsonFiles) {
    try {
      const raw = fs.readFileSync(path.join(requestsDir, file), "utf-8");
      out.push(JSON.parse(raw));
    } catch {
      // Malformed or partially-written files — skip in read-only scan.
    }
  }
  return out;
}

// ─── IO helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(logFile, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, line);
  console.log(line.trim());
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

// ─── Process / git helpers ───────────────────────────────────────────────────

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readDiffSnapshot(worktree) {
  if (!fs.existsSync(worktree)) return "";
  try {
    const unstaged = execSync("git diff --stat", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const staged = execSync("git diff --staged --stat", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const commits = execSync("git log -n 5 --oneline", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return `${unstaged}\n${staged}\n${commits}\n${untracked}`;
  } catch { return ""; }
}

function readTail(filePath, lines) {
  if (!fs.existsSync(filePath)) return "";
  try {
    return execSync(`tail -n ${lines} "${filePath}"`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}

// Captures uncommitted+untracked state in a recovery tag, then resets the worktree.
// Returns { tag: string | null, error: string | null }.
// If error is set the worktree was NOT touched — the caller must abort the restart.
function captureRecoveryAndReset(worktree, agent, log) {
  try {
    const headBefore = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
    let createdRecovery = false;
    try {
      execSync("git add -A", { cwd: worktree, stdio: "ignore" });
      try {
        execSync(`git commit -m "RECOVERY: pre-hard-restart"`, { cwd: worktree, stdio: "ignore" });
        createdRecovery = true;
      } catch {
        // nothing to commit
      }
    } catch (err) {
      log(`Recovery staging failed: ${err.message}`);
    }

    let tag = null;
    if (createdRecovery) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      tag = `recovery/${agent}/${ts}`;
      try {
        execSync(`git tag "${tag}"`, { cwd: worktree, stdio: "ignore" });
      } catch (err) {
        log(`Failed to create recovery tag: ${err.message}`);
        // Recovery commit is on HEAD but the tag is missing — abort before
        // the destructive reset, otherwise the commit is orphaned (reflog-only).
        return { tag: null, error: `recovery commit created but tag failed: ${err.message}` };
      }
    }

    execSync(`git reset --hard ${headBefore}`, { cwd: worktree, stdio: "ignore" });
    execSync("git clean -fd", { cwd: worktree, stdio: "ignore" });
    return { tag, error: null };
  } catch (err) {
    log(`Hard reset failed: ${err.message}`);
    return { tag: null, error: `hard reset failed: ${err.message}` };
  }
}

// Runs the agent's validation command in its worktree. Two forms are accepted:
//   • argv array (e.g. ["npm", "run", "test"]) — runs with shell:false, no expansion, no injection surface.
//   • shell string (e.g. "npm run test -- src") — runs through /bin/sh -c, retained for ergonomics
//     (pipes, &&, env vars). Logged as "(shell form)" so the trust requirement stays visible.
function runValidation(agent, log) {
  const cmd = agent.validate_cmd;
  if (!cmd || cmd === "null") return { passed: true, log: "" };
  if (Array.isArray(cmd) && cmd.length === 0) return { passed: true, log: "" };

  const isArgv = Array.isArray(cmd);
  log(`Running validation${isArgv ? "" : " (shell form)"}: ${isArgv ? cmd.join(" ") : cmd}`);

  const result = isArgv
    ? spawnSync(cmd[0], cmd.slice(1), {
        cwd: agent.worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], shell: false,
      })
    : spawnSync(cmd, {
        cwd: agent.worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], shell: true,
      });

  if (result.error) {
    log(`Validation invocation failed: ${result.error.message}`);
    return { passed: false, log: result.error.message };
  }
  if (result.status !== 0) {
    const out = (result.stdout || "") + "\n" + (result.stderr || "");
    log(`Validation failed (exit ${result.status}).`);
    return { passed: false, log: out };
  }
  log(`Validation passed.`);
  return { passed: true, log: "" };
}

function collectWorktreeStates(pending, agents) {
  const states = {};
  for (const req of pending) {
    if (states[req.agent] || !agents[req.agent]) continue;
    const worktree = agents[req.agent].worktree;
    if (!fs.existsSync(worktree)) continue;
    try {
      const status = execSync("git status -s", { cwd: worktree, encoding: "utf-8" });
      const baseBranch = agents[req.agent].base_ref || "main";

      const diffStatUnstaged = execSync("git diff --stat", { cwd: worktree, encoding: "utf-8" });
      const diffStatStaged = execSync("git diff --staged --stat", { cwd: worktree, encoding: "utf-8" });
      const diffStatBranch = execSync(`git diff ${baseBranch}...HEAD --stat`, { cwd: worktree, encoding: "utf-8" });

      let targetedDiffs = "";
      try {
        const filesChanged = execSync(`git diff ${baseBranch}...HEAD --name-only`, { cwd: worktree, encoding: "utf-8" }).split("\n").filter(Boolean);
        for (const file of filesChanged) {
          if (req.content.includes(file) || req.content.includes(path.basename(file))) {
            const fileDiff = execSync(`git diff ${baseBranch}...HEAD -- "${file}"`, { cwd: worktree, encoding: "utf-8" });
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

// Builds the arbitration prompt sent to the orchestrator CLI for each pending-request cycle.
function buildOrchestratorPrompt(requests, context, durableDecisions, decisions, worktreeStates) {
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
// in orchestrator.config.js so monitoring runs through a configurable (often cheap) model.
function callOrchestratorCli(prompt, parsedConfig, maxRetries, log) {
  const cli = parsedConfig.orchestrator_cli;
  const template = parsedConfig.cli_templates[cli];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const mode = template ? cliTemplateMode(template) : "missing-template";
    log(`Calling orchestrator CLI '${cli}' via ${mode} mode (attempt ${attempt}/${maxRetries})...`);
    const { stdout, error } = invokeOrchestratorCli(cli, template, prompt);
    if (error) {
      log(`Orchestrator CLI failed: ${error}`);
      if (attempt === maxRetries) return null;
      continue;
    }
    const match = stdout.match(/\{[\s\S]*\}/);
    if (!match) {
      log(`No JSON object in CLI output (attempt ${attempt}).`);
      if (attempt === maxRetries) return null;
      continue;
    }
    try {
      const parsed = JSON.parse(match[0]);
      log(`Orchestrator CLI call succeeded.`);
      return parsed;
    } catch (err) {
      log(`JSON parse failed: ${err.message}`);
      if (attempt === maxRetries) return null;
    }
  }
  return null;

  // Single-use helper — only called from the retry loop above.
  function invokeOrchestratorCli(cli, template, prompt) {
    if (template) {
      const promptFile = path.join(os.tmpdir(), `orch-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, "utf-8");
      try {
        const { result } = spawnCliTemplateSync(cli, template, {
          promptFile,
          promptText: prompt,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024 * 10,
        });
        if (result.error) return { stdout: "", error: result.error.message };
        if (result.status !== 0) return { stdout: result.stdout || "", error: `Exit ${result.status}: ${result.stderr}` };
        return { stdout: result.stdout || "" };
      } catch (err) {
        return { stdout: "", error: err.message };
      } finally {
        try { fs.unlinkSync(promptFile); } catch {}
      }
    }
    return { stdout: "", error: `No cli_templates.${cli} configured for orchestrator_cli.` };
  }
}

function generateAiReviewInstruction(tailLogs, parsedConfig, log) {
  const reviewPrompt = `This agent is stuck.

Look at its last 50 lines of logs and identify what it is failing to understand.
Write exactly one sentence I can send it to break it out of this loop.

## Last 50 Log Lines
${tailLogs}`;
  const cli = parsedConfig.default_cli;
  const template = parsedConfig.cli_templates[cli];
  const promptFile = path.join(os.tmpdir(), `review-prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, reviewPrompt, "utf-8");
  try {
    if (template) {
      log(`Triggered AI Review invoking '${cli}' via ${cliTemplateMode(template)} mode...`);
      const { result } = spawnCliTemplateSync(cli, template, {
        promptFile,
        promptText: reviewPrompt,
        encoding: "utf-8",
        timeout: 60000,
      });
      if (result.stdout?.trim()) return result.stdout.trim();
    } else {
      log(`Triggered AI Review skipped: no cli_templates.${cli} configured.`);
    }
  } catch (e) {
    log(`Triggered AI Review failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
  return "You seem stuck. Please review the logs and continue.";
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
      fs.unlinkSync(stalledFlag);
      log("Cleared stalled flag — orchestrator CLI recovered.");
    } catch {}
  }
}

// ─── Final summary phase ─────────────────────────────────────────────────────

function finalize(config, paths, parsedConfig, log) {
  const agents = readJSON(paths.agents);
  const summaries = [];
  let workerCli = "kilo";
  let baseBranch = "main";

  const failedAgents = [];
  for (const name in agents) {
    const a = agents[name];
    if (a.cli) workerCli = a.cli;
    if (a.base_ref) baseBranch = a.base_ref;
    if (a.status === "exited" || a.status === "errored") {
      failedAgents.push(`${name} (${a.status}): ${(a.task || "").toString().slice(0, 80)}`);
    }
    summaries.push(`- Agent: ${name}\n  Status: ${a.status}\n  Task: ${a.task}\n  Branch: ${name}`);
  }

  const agentsList = summaries.join("\n\n");
  const summaryFile = path.join(config.coordDir, "review-summary.txt");

  if (failedAgents.length > 0) {
    const fallback = `RUN INCOMPLETE\n\nSome agents failed or vanished before completing their work:\n${failedAgents.join("\n")}\n\nFull agent list:\n\n${agentsList}\n\nNext: inspect the worktrees and logs before merging.`;
    fs.writeFileSync(summaryFile, fallback, "utf-8");
    log(`Run ended incomplete (${failedAgents.length} agents failed/vanished). Skipping AI review summary.`);
    console.log("\n" + fallback + "\n");
    log("Orchestrator loop ending.");
    return;
  }
  log("All worker agents completed. Spawning worker session for review summary...");
  const shortPrompt = `You are reviewing the completed output of a multi-agent coding project. Each agent worked in an isolated git branch.

Please run git commands yourself (e.g., 'git diff ${baseBranch}...<branch-name>') to inspect the work done by the following agents:

${agentsList}

Write a concise plain-text summary suitable for display in a terminal window. Include:
1) A 2-3 sentence executive summary.
2) For each agent: a bullet summarizing what was built and any concerns you find by inspecting their diffs.
3) A short Merge Order recommendation.

Keep the total output under 50 lines. Be direct.`;

  const promptFile = path.join(os.tmpdir(), `review-prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, shortPrompt, "utf-8");

  let summaryOutput = "";
  try {
    const template = parsedConfig.cli_templates[workerCli];
    let result;
    if (template) {
      log(`Calling ${workerCli} for review summary via ${cliTemplateMode(template)} mode...`);
      result = spawnCliTemplateSync(workerCli, template, {
        promptFile,
        promptText: shortPrompt,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 10,
        timeout: 120000,
      }).result;
    } else {
      throw new Error(`No cli_templates.${workerCli} configured for review summary.`);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${workerCli} exited with status ${result.status}: ${result.stderr}`);
    summaryOutput = result.stdout;
    fs.writeFileSync(summaryFile, summaryOutput, "utf-8");
    log(`Review summary generated by ${workerCli}.`);
  } catch (err) {
    log(`Worker review failed (${err.message}). Writing raw stats fallback.`);
    summaryOutput = `ALL AGENTS COMPLETED\n\n${agentsList}\n\nNext: return to your interactive orchestrator session and say "The agents are done. Please review and integrate their work."`;
    fs.writeFileSync(summaryFile, summaryOutput, "utf-8");
  }
  try { fs.unlinkSync(promptFile); } catch {}

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
      execSync(`start cmd /k "type ${summaryFile}"`, { shell: "cmd.exe" });
    } else {
      execSync(`x-terminal-emulator -e "cat '${summaryFile}'; read -p 'Press Enter to close...'" || xterm -e "cat '${summaryFile}'; read -p 'Press Enter to close...'"`, { shell: "/bin/bash" });
    }
    log("Opened review summary in new terminal window.");
  } catch (err) {
    log(`Could not open new terminal: ${err.message}. Printing summary inline.`);
    console.log("\n" + summaryOutput + "\n");
  }
  log("Orchestrator loop ending.");
}

module.exports = {
  buildOrchestratorPrompt,
};
