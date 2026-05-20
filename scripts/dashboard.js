#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { parseAgentState } = require("./lib/agent-log-parser");
const { STATUS } = require("./lib/status");
const { tailLines } = require("./lib/log-tail");

// Per-agent cache so an idle log isn't re-read every render tick. Keyed by log
// path. We invalidate when the file's mtime or size changes; a shrink means
// the spawn-agent rotation kicked in and we should refresh.
const logTailCache = new Map();

let coordDir = "./coord";
let intervalMs = 2000;
let clearScreen = true;

const argv = process.argv;
for (let i = 2; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--coord" && i + 1 < argv.length) {
    coordDir = argv[++i];
  } else if (arg === "--interval" && i + 1 < argv.length) {
    intervalMs = parseInt(argv[++i], 10) || 2000;
  } else if (arg === "--no-clear") {
    clearScreen = false;
  } else if (arg === "--no-color") {
    process.env.NO_COLOR = "1";
  }
}

const agentsFile = path.join(coordDir, "agents.json");
const contextFile = path.join(coordDir, "context.json");
const requestsFile = path.join(coordDir, "requests.jsonl");
const stalledFlagFile = path.join(coordDir, "orchestrator-stalled.flag");
const abortFlagFile = path.join(coordDir, "abort.flag");
let renderTimer;

// Closing the terminal window (SIGHUP / SIGTERM) just exits the dashboard.
// Worktrees are left intact — only an explicit confirmation triggers abort.
process.on("SIGHUP", () => exitDashboard("Dashboard closed (SIGHUP). Agents continue running in the background."));
process.on("SIGTERM", () => exitDashboard("Dashboard closed (SIGTERM). Agents continue running in the background."));

// Ctrl+C: ask before signalling the loop.
process.on("SIGINT", () => {
  if (renderTimer) clearInterval(renderTimer);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(
    "\nAbort all running agents? Worktrees will be preserved (uncommitted work stays put). [y/N] ",
    (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "y") {
        try {
          fs.writeFileSync(abortFlagFile, JSON.stringify({
            pid: process.pid,
            written_at: new Date().toISOString(),
          }) + "\n");
        } catch {}
        console.log("Abort flag written. Orchestrator loop will stop agents and exit.");
      } else {
        console.log("Abort cancelled. Closing dashboard only.");
      }
      process.exit(0);
    },
  );
});

function exitDashboard(message) {
  if (renderTimer) clearInterval(renderTimer);
  console.log("\n" + message);
  process.exit(0);
}

renderTimer = setInterval(render, intervalMs);
render();

function render() {
  if (clearScreen) process.stdout.write("\x1Bc");
  console.log(`=== ORCHESTRATOR DASHBOARD ===  [${new Date().toLocaleTimeString()}]`);
  console.log(`Press Ctrl+C to abort agents (with confirmation). Closing this window will NOT stop them.\n`);

  renderStalledBanner();
  renderAgents();
  renderPendingRequests();
  renderRecentDecisions();
}

function renderStalledBanner() {
  if (!fs.existsSync(stalledFlagFile)) return;
  try {
    const info = JSON.parse(fs.readFileSync(stalledFlagFile, "utf-8"));
    console.log("ORCHESTRATOR CLI STALLED");
    console.log(`   ${info.message}`);
    console.log(`   Pending: ${info.pending_requests}  |  High-priority blocked: ${info.high_priority_requests}`);
    console.log(`   Since: ${info.timestamp}\n`);
  } catch {
    console.log("Orchestrator stalled flag present but unreadable.\n");
  }
}

function renderAgents() {
  console.log("AGENT STATUS");
  try {
    const agents = JSON.parse(fs.readFileSync(agentsFile, "utf-8"));
    const agentNames = Object.keys(agents);
    if (agentNames.length === 0) {
      console.log("No agents running yet.");
      return;
    }
    // The immutable task description lives in context.json; agents.json's
    // `task` is a fallback for runs bootstrapped before context.json existed.
    let tasks = {};
    try {
      tasks = JSON.parse(fs.readFileSync(contextFile, "utf-8")).tasks || {};
    } catch {}
    console.table(
      agentNames.map((name) => {
        const a = agents[name];
        const taskText = String(tasks[name]?.description || a.task || "Initial prompt");
        let info = taskText.slice(0, 40) + (taskText.length > 40 ? "..." : "");
        if (a.status === STATUS.NEEDS_ATTENTION) {
          // Parked for a human. The reason lives on the agent record, not the
          // log, so this branch does not depend on a log file existing.
          const reason = String(a.attention_reason || "(no reason recorded)").slice(0, 40);
          info = `${colorAttention("ATTENTION:")} ${reason}`;
        } else try {
          const logPath = path.join(coordDir, "logs", `${name}.log`);
          const logs = readLogTailLines(logPath, 50);
          if (logs) {
            const lastLine = logs[logs.length - 1] || "";
            if (a.status === "errored") {
              info = `ERROR: ${lastLine.slice(0, 40)}`;
            } else if (a.status === "exited") {
              const exitTail = a.exit_log_tail || "";
              const exitLastLine = exitTail ? exitTail.trim().split("\n").pop() || "" : "";
              info = `VANISHED: ${exitLastLine.slice(0, 40)}`;
            } else if (a.status === "running") {
              const parsedState = parseAgentState(logs);
              info = parsedState ? `> ${parsedState}` : `[Log] ${lastLine.slice(0, 40)}`;
            }
          }
        } catch {}
        return {
          Agent: name,
          Status: a.status,
          CLI: a.cli || "kilo",
          PID: a.pid,
          Restarts: a.restart_count ?? 0,
          Started: formatTimestamp(a.started_at),
          Spawned: formatTimestamp(a.current_started_at || a.last_spawned_at || a.started_at),
          Info: info,
        };
      }),
    );
  } catch {
    console.log("Waiting for agents.json...");
  }

  // Amber so a parked agent reads as "warning / awaiting human" — distinct
  // from the red a reader expects for `errored`. The token is colored rather
  // than the Status column because console.table includes ANSI bytes in its
  // width math, which misaligns a colored column. Skipped for non-TTY/NO_COLOR
  // so piped or captured output stays clean.
  function colorAttention(text) {
    if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
    return `\x1b[33m${text}\x1b[0m`;
  }
}

// Shared — used by renderAgents for both `running` and `errored` rows.
// Returns the trailing N lines as an array (no trailing-newline element), or
// null when the log file doesn't exist. Caches the parsed array per-path and
// re-uses it when the file's stat hasn't changed since the last call.
function readLogTailLines(logPath, lineCount) {
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    logTailCache.delete(logPath);
    return null;
  }
  if (!stat.isFile()) {
    logTailCache.delete(logPath);
    return null;
  }
  const cached = logTailCache.get(logPath);
  // Same mtime AND same or larger size → safe to return cached lines. A shrink
  // (size < cached.size) implies log rotation; refresh.
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.lines;
  }
  const tail = tailLines(logPath, lineCount);
  const trimmed = tail.replace(/\n+$/, "");
  const lines = trimmed === "" ? [] : trimmed.split("\n");
  logTailCache.set(logPath, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
  return lines;
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function renderPendingRequests() {
  console.log("\nPENDING REQUESTS");
  try {
    if (!fs.existsSync(requestsFile)) {
      console.log("No pending requests.");
      return;
    }
    const lines = fs.readFileSync(requestsFile, "utf-8").split("\n").filter((l) => l.trim() !== "");
    const pending = lines.map((l) => JSON.parse(l)).filter((r) => r.status === "pending");
    if (pending.length === 0) {
      console.log("No pending requests.");
      return;
    }
    console.table(
      pending.map((r) => ({ ID: r.request_id, Agent: r.agent, Type: r.type, Priority: r.priority })),
    );
  } catch {
    console.log("Waiting for requests.jsonl...");
  }
}

function renderRecentDecisions() {
  console.log("\nRECENT ORCHESTRATOR DECISIONS (Last 5)");
  try {
    const decisionsPath = path.join(coordDir, "decisions.json");
    if (!fs.existsSync(decisionsPath)) return;
    const decisions = JSON.parse(fs.readFileSync(decisionsPath, "utf-8"));
    if (decisions.length === 0) {
      console.log("No decisions made yet.");
      return;
    }
    const recent = decisions.slice(-5).reverse();
    console.table(
      recent.map((d) => ({
        RequestID: d.request_id,
        Decision: d.decision.slice(0, 50) + (d.decision.length > 50 ? "..." : ""),
        Reason: d.reason.slice(0, 50) + (d.reason.length > 50 ? "..." : ""),
      })),
    );
  } catch {
    console.log("Waiting for decisions.json...");
  }
}
