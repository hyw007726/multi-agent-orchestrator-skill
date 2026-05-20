const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readJSON, readJSONL } = require("./locking");
const { appendEvent } = require("./events");
const { STATUS } = require("./status");

// ─── Terminal helpers ────────────────────────────────────────────────────────
// Shared — used by finalize and by orchestrator-loop's launchDashboard.

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
  shellQuote,
  runAppleScriptTerminal,
  writeStalledFlag,
  clearStalledFlag,
  finalize,
  runSummaryTerminal,
  buildFinalSummary,
  latestReviewRequestForAgent,
  truncate,
};
