#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";

const coordDir = process.argv[2] === "--coord" ? process.argv[3] : "./coord";
const agentsFile = path.join(coordDir, "agents.json");
const requestsFile = path.join(coordDir, "requests.jsonl");

function clearScreen() {
  process.stdout.write("\x1Bc");
}

function handleAbort() {
  console.log("\n🛑 Dashboard closed. Sending abort signal to Orchestrator...");
  try {
    fs.writeFileSync(path.join(coordDir, "abort.flag"), "true");
  } catch (e) {}
  process.exit(0);
}

process.on("SIGINT", handleAbort);
process.on("SIGHUP", handleAbort);
process.on("SIGTERM", handleAbort);

function render() {
  clearScreen();
  console.log(`=== KILO ORCHESTRATOR DASHBOARD ===  [${new Date().toLocaleTimeString()}]`);
  console.log(`🛑 Press Ctrl+C or close this window to safely abort all agents.\n`);

  try {
    const agents = JSON.parse(fs.readFileSync(agentsFile, "utf-8"));
    const agentNames = Object.keys(agents);
    console.log("🟢 AGENT STATUS");
    if (agentNames.length === 0) {
      console.log("No agents running yet.");
    } else {
      console.table(
        agentNames.map((name) => {
          let extraInfo = agents[name].task.slice(0, 40) + (agents[name].task.length > 40 ? "..." : "");
          
          try {
            const logPath = path.join(coordDir, "logs", `${name}.log`);
            if (fs.existsSync(logPath)) {
              const logs = fs.readFileSync(logPath, "utf-8").trim().split("\n");
              const lastLine = logs.pop();
              if (lastLine) {
                if (agents[name].status === "errored") {
                  extraInfo = `ERROR: ${lastLine.slice(0, 40)}`;
                } else if (agents[name].status === "running") {
                  extraInfo = `[Log] ${lastLine.slice(0, 40)}`;
                }
              }
            }
          } catch (e) {}

          return {
            Agent: name,
            Status: agents[name].status,
            CLI: agents[name].cli || "kilo",
            PID: agents[name].pid,
            Info: extraInfo,
          };
        })
      );
    }
  } catch (e) {
    console.log("Waiting for agents.json...");
  }

  console.log("\n🟡 PENDING REQUESTS");
  try {
    if (fs.existsSync(requestsFile)) {
      const lines = fs.readFileSync(requestsFile, "utf-8").split("\n").filter((line) => line.trim() !== "");
      const requests = lines.map((line) => JSON.parse(line));
      const pending = requests.filter((r: any) => r.status === "pending");
      if (pending.length === 0) {
        console.log("No pending requests.");
      } else {
        console.table(
          pending.map((r: any) => ({
            ID: r.request_id,
            Agent: r.agent,
            Type: r.type,
            Priority: r.priority,
          }))
        );
      }
    } else {
      console.log("No pending requests.");
    }
  } catch (e) {
    console.log("Waiting for requests.jsonl...");
  }

  console.log("\n📘 RECENT ORCHESTRATOR DECISIONS (Last 5)");
  try {
    const decisionsPath = path.join(coordDir, "decisions.json");
    if (fs.existsSync(decisionsPath)) {
      const decisions = JSON.parse(fs.readFileSync(decisionsPath, "utf-8"));
      if (decisions.length === 0) {
        console.log("No decisions made yet.");
      } else {
        const recent = decisions.slice(-5).reverse();
        console.table(
          recent.map((d: any) => ({
            RequestID: d.request_id,
            Decision: d.decision.slice(0, 50) + (d.decision.length > 50 ? "..." : ""),
            Reason: d.reason.slice(0, 50) + (d.reason.length > 50 ? "..." : "")
          }))
        );
      }
    }
  } catch (e) {
    console.log("Waiting for decisions.json...");
  }
}

setInterval(render, 2000);
render();
