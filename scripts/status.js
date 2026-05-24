#!/usr/bin/env node

/**
 * Canonical "what's happening right now" probe for an orchestrated run.
 *
 * Reads `coord/agents.json`, `coord/events.jsonl`, and any
 * `coord/orchestrator-stalled.flag` / `coord/abort.flag`, and emits a single
 * snapshot. Designed to be safe to run at any time: if `coord/` is missing or
 * empty, it returns a structured "no run" result rather than crashing.
 *
 * Usage:
 *   node scripts/status.js --coord ./coord
 *   node scripts/status.js --coord ./coord --json
 *
 * Default output is human-readable text on stdout. With `--json`, the script
 * writes a single JSON document to stdout and nothing else (fatal errors go to
 * stderr). Exit codes:
 *   0   read succeeded (including the "no run" case).
 *   1   could not read or parse coord/ contents.
 *
 * JSON envelope (stable schema; see references/schemas.md for the full doc):
 *   {
 *     "ok": true,
 *     "errors": [],
 *     "coord_dir": "./coord",
 *     "loop_state": "no_run | running | needs_attention | stalled | aborting | completed",
 *     "stalled": null | { ...orchestrator-stalled.flag payload },
 *     "abort_requested": false | true,
 *     "agents": [
 *       {
 *         "name": "agent-foo",
 *         "status": "running | needs_attention | completed | terminated | exited",
 *         "last_event_seq": 42,            // 1-based line number in events.jsonl, or null
 *         "last_event": "agent_spawned",   // event type from the same record, or null
 *         "blocker": "liveness timeout"    // omitted when no blocker is known
 *       }
 *     ]
 *   }
 */

"use strict";

const fs = require("fs");
const path = require("path");

runStatus();

function runStatus() {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(usage() + "\n");
    return;
  }

  const snapshot = collectSnapshot(args.coordDir);

  if (args.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
  } else {
    process.stdout.write(formatHuman(snapshot) + "\n");
  }

  process.exit(snapshot.ok ? 0 : 1);
}

function parseArgs() {
  const out = { coordDir: "./coord", json: false, help: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--coord":
        out.coordDir = argv[++i];
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        process.stderr.write(`Unknown option: ${argv[i]}\n${usage()}\n`);
        process.exit(2);
    }
  }
  return out;
}

function usage() {
  return [
    "Report the current state of an orchestrated run.",
    "",
    "Options:",
    "  --coord <dir>   Coordination directory (default: ./coord)",
    "  --json          Emit a single JSON document on stdout",
    "  --help          Show this help message",
    "",
    "Example:",
    "  node scripts/status.js --coord ./coord --json",
  ].join("\n");
}

// Builds the snapshot object that both renderers consume. Catches I/O errors
// per source file so a single bad file (e.g. truncated events.jsonl) does not
// hide the rest of the snapshot.
function collectSnapshot(coordDir) {
  const result = {
    ok: true,
    errors: [],
    coord_dir: coordDir,
    loop_state: "no_run",
    stalled: null,
    abort_requested: false,
    agents: [],
  };

  if (!fs.existsSync(coordDir)) {
    return result;
  }

  const agentsPath = path.join(coordDir, "agents.json");
  const eventsPath = path.join(coordDir, "events.jsonl");
  const stalledPath = path.join(coordDir, "orchestrator-stalled.flag");
  const abortPath = path.join(coordDir, "abort.flag");

  const agents = readAgents(agentsPath, result.errors);
  const lastEventByAgent = scanLastEventPerAgent(eventsPath, result.errors);

  result.stalled = readStalledFlag(stalledPath, result.errors);
  result.abort_requested = fs.existsSync(abortPath);

  const agentNames = Object.keys(agents).sort();
  for (const name of agentNames) {
    const agent = agents[name] || {};
    const entry = {
      name,
      status: agent.status || "unknown",
      last_event_seq: null,
      last_event: null,
    };
    const last = lastEventByAgent.get(name);
    if (last) {
      entry.last_event_seq = last.seq;
      entry.last_event = last.event;
    }
    const blocker = deriveBlocker(agent);
    if (blocker) entry.blocker = blocker;
    result.agents.push(entry);
  }

  result.loop_state = deriveLoopState(result.agents, result.stalled, result.abort_requested);
  if (result.errors.length > 0) result.ok = false;
  return result;
}

function readAgents(agentsPath, errors) {
  if (!fs.existsSync(agentsPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    errors.push(`agents.json is not a JSON object`);
    return {};
  } catch (err) {
    errors.push(`failed to read agents.json: ${err.message}`);
    return {};
  }
}

// Streams events.jsonl once and keeps only the last event per agent. Lines
// without an `agent` field are still counted toward the sequence number so the
// returned seq matches the file's 1-based line number.
function scanLastEventPerAgent(eventsPath, errors) {
  const out = new Map();
  if (!fs.existsSync(eventsPath)) return out;
  let text;
  try {
    text = fs.readFileSync(eventsPath, "utf-8");
  } catch (err) {
    errors.push(`failed to read events.jsonl: ${err.message}`);
    return out;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // Malformed lines shouldn't fail the whole probe; skip them.
      continue;
    }
    const agent = record && typeof record.agent === "string" ? record.agent : null;
    if (!agent) continue;
    out.set(agent, { seq: i + 1, event: record.event || null });
  }
  return out;
}

function readStalledFlag(flagPath, errors) {
  if (!fs.existsSync(flagPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(flagPath, "utf-8"));
  } catch (err) {
    errors.push(`failed to read orchestrator-stalled.flag: ${err.message}`);
    return { unreadable: true };
  }
}

function deriveBlocker(agent) {
  if (agent.attention_reason) return String(agent.attention_reason);
  if (agent.status === "exited" && agent.exit_log_tail) {
    const tail = String(agent.exit_log_tail).trim().split("\n").pop() || "";
    if (tail) return `exited: ${tail.slice(0, 120)}`;
  }
  return null;
}

// Priority: stalled flag wins, then abort, then per-agent states. "completed"
// only when every agent reached a terminal state.
function deriveLoopState(agents, stalled, abortRequested) {
  if (agents.length === 0) return "no_run";
  if (stalled) return "stalled";
  if (abortRequested) return "aborting";

  // `needs_attention` belongs in the terminal set because the loop will never
  // advance a parked agent on its own — for "is the loop still doing work?"
  // semantics it counts as done. It does NOT mean the run completed cleanly:
  // the `hasAttention` short-circuit below fires first and returns
  // "needs_attention", so `loop_state: "completed"` can only be reached when
  // every agent is completed/terminated/exited and none are parked.
  const terminal = new Set(["completed", "terminated", "exited", "needs_attention"]);
  let hasRunning = false;
  let hasAttention = false;
  let allTerminal = true;
  for (const agent of agents) {
    if (agent.status === "needs_attention") hasAttention = true;
    if (agent.status === "running") hasRunning = true;
    if (!terminal.has(agent.status)) allTerminal = false;
  }
  if (hasAttention) return "needs_attention";
  if (hasRunning) return "running";
  if (allTerminal) return "completed";
  return "running";
}

function formatHuman(snapshot) {
  const lines = [];
  lines.push(`Coord: ${snapshot.coord_dir}`);
  lines.push(`Loop state: ${snapshot.loop_state}`);
  if (snapshot.stalled) {
    const msg = snapshot.stalled.message || "(orchestrator-stalled.flag present)";
    lines.push(`Stalled: ${msg}`);
  }
  if (snapshot.abort_requested) lines.push("Abort requested: yes");

  if (snapshot.agents.length === 0) {
    lines.push("");
    lines.push("No agents recorded yet.");
  } else {
    lines.push("");
    lines.push("Agents:");
    for (const agent of snapshot.agents) {
      const seqText = agent.last_event_seq === null ? "-" : `#${agent.last_event_seq}`;
      const eventText = agent.last_event ? ` ${agent.last_event}` : "";
      const blockerText = agent.blocker ? `  blocker=${agent.blocker}` : "";
      lines.push(`  - ${agent.name}: ${agent.status}  (event ${seqText}${eventText})${blockerText}`);
    }
  }

  if (snapshot.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const err of snapshot.errors) lines.push(`  - ${err}`);
  }

  return lines.join("\n");
}

module.exports = { collectSnapshot, deriveLoopState };
