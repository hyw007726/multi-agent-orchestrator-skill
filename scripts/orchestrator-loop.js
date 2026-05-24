#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { pidMatchesCli, getProcessCommandMap, safeKill } = require("./lib/process");
const { acquireInstanceLock, readJSON, readJSONL, updateJSON, appendJSONL } = require("./lib/locking");
const { STATUS, transitionAgentStatus, parkAgentForAttention, parkRationale } = require("./lib/status");
const { appendEvent } = require("./lib/events");
const { tailLines } = require("./lib/log-tail");
const { consolidateStagedRequests, readStagedRequests } = require("./lib/staged-requests");
const { isValidationRunning, killValidationRunner } = require("./lib/validation-control");
const { hasPendingProgressTimeoutRequest, buildProgressTimeoutRequest, stampProgressMilestone, readProgressHeartbeat, heartbeatChanged, shouldGrantHeartbeatGrace, readDiffSnapshot, readDiffHash } = require("./lib/progress-tracking");
const { RECENT_DECISION_LIMIT, collectWorktreeStates, buildBoundedArbitrationPrompt, callOrchestratorCli, validateArbitrationResponse } = require("./lib/arbitration");
const { shellQuote, runAppleScriptTerminal, writeStalledFlag, clearStalledFlag, finalize } = require("./lib/finalize");
const { processApprovals } = require("./lib/approvals");
const { processActions, processFinishedValidations, sweepRestartPrompts, expectedProcessForAgent } = require("./lib/actions");
const { getPaths } = require("./lib/paths");

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
  // Shared context for lib/approvals.js + lib/actions.js helpers that were
  // previously runLoop-scope closures. Captures the per-run state they need
  // so they can live as top-level functions.
  const ctx = { paths, log, runId, coordDir: config.coordDir, parsedConfig };

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

      processFinishedValidations(ctx);

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
          // Liveness timeout means the worker is unresponsive; SIGTERM may be
          // trapped or ignored. Wait for the grace window, then SIGKILL so the
          // worker is provably gone before we flip the agent to attention —
          // operators inspecting the worktree shouldn't be racing the old PID.
          safeKill({ pid: agent.pid, expectedCli: expectedProcessForAgent(agent, parsedConfig), recordedCmdline: agent.spawned_cmdline, log, coordDir: config.coordDir, agent: name, waitForExitMs: 5000 });
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
          // Validate the parsed envelope BEFORE applying any side effects.
          // Half-applying a malformed response (e.g. killing a worker but never
          // recording why, or approving some requests but leaving others stale
          // 'pending') is the kind of state we can't recover from. A failed
          // cycle here is recoverable: the pending requests stay pending and
          // the next tick re-asks.
          const validation = validateArbitrationResponse(response, pending);
          if (!validation.ok) {
            log(`Arbitration response rejected before side effects: ${validation.reasons.join(" ")}`);
            appendEvent(config.coordDir, "arbitration_response_rejected", {
              reason: "validation failed",
              data: {
                reasons: validation.reasons,
                pending_count: pending.length,
                approved_count: Array.isArray(response.approved) ? response.approved.length : 0,
                rejected_count: Array.isArray(response.rejected) ? response.rejected.length : 0,
                actions_count: Array.isArray(response.actions) ? response.actions.length : 0,
              },
            });
          } else {
            processActions(ctx, response.actions || [], { response, pending });
            processApprovals(ctx, response, { pending });
          }
        }
      } else {
        // ── All-done check ────────────────────────────────────────────────
        const agents = readJSON(paths.agents);
        const entries = Object.values(agents);
        // needs_attention is terminal for "can the loop exit?": a parked agent
        // is awaiting a human and the loop will never advance it on its own.
        const allDone = entries.length > 0 &&
          entries.every((a) => a.status === "completed" || a.status === "terminated" || a.status === "exited" || a.status === STATUS.NEEDS_ATTENTION);
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
