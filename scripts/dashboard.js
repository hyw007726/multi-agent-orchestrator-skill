#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const coordDir = process.argv[2] === "--coord" ? process.argv[3] : "./coord";
const agentsFile = path.join(coordDir, "agents.json");
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
        try { fs.writeFileSync(abortFlagFile, "true"); } catch {}
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

renderTimer = setInterval(render, 2000);
render();

function render() {
  process.stdout.write("\x1Bc");
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
    console.table(
      agentNames.map((name) => {
        const a = agents[name];
        let info = a.task.slice(0, 40) + (a.task.length > 40 ? "..." : "");
        try {
          const logPath = path.join(coordDir, "logs", `${name}.log`);
          if (fs.existsSync(logPath)) {
            const logs = fs.readFileSync(logPath, "utf-8").trim().split("\n");
            const lastLine = logs[logs.length - 1] || "";
            if (a.status === "errored") {
              info = `ERROR: ${lastLine.slice(0, 40)}`;
            } else if (a.status === "exited") {
              const exitTail = a.exit_log_tail || "";
              const exitLastLine = exitTail ? exitTail.trim().split("\n").pop() || "" : "";
              info = `VANISHED: ${exitLastLine.slice(0, 40)}`;
            } else if (a.status === "running") {
              const parsedState = parseAgentState(logs.slice(-50));
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
          Info: info,
        };
      }),
    );
  } catch {
    console.log("Waiting for agents.json...");
  }
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

// Single-use helper — only called from renderAgents above.
function parseAgentState(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/Editing file:?\s+(.*)/i))) return `Editing: ${m[1]}`;
    if ((m = line.match(/Tool Use:\s+(?:replace|write_file|edit)\s+.*?in\s+(.*)/i))) return `Editing: ${m[1]}`;
    if (line.match(/Tool Use:\s+replace\s*(.*)/i)) return `Editing file`;
    if ((m = line.match(/Tool Use:\s+read_file\s+(.*)/i))) return `Reading: ${m[1]}`;
    if ((m = line.match(/Tool Use:\s+bash\s+(.*)/i)) || (m = line.match(/Running command:?\s+(.*)/i))) {
      return `Running: ${m[1].substring(0, 30)}...`;
    }
    if ((m = line.match(/Tokens:\s+(\d+)/i))) return `Processing... (Tokens: ${m[1]})`;
    if ((m = line.match(/Applied edit to\s+(.*)/i))) return `Saved: ${m[1]}`;
    if (line.match(/Running tests/i)) return `Testing...`;
  }
  return null;
}
