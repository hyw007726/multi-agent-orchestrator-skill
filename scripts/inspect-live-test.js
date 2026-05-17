#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const workspace = resolveWorkspace(args);
    const info = inspectLiveWorkspace(workspace);
    if (args.idOnly) {
      process.stdout.write(`${info.session_id}\n`);
    } else if (args.json) {
      process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    } else {
      process.stdout.write(formatInspection(info));
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    process.exit(1);
  }
}

function parseArgs(argv = []) {
  const out = {
    workspace: null,
    latest: false,
    provider: null,
    idOnly: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--latest") {
      out.latest = true;
      const maybeProvider = argv[i + 1];
      if (maybeProvider && !maybeProvider.startsWith("--")) {
        out.provider = maybeProvider;
        i++;
      }
    } else if (arg === "--provider") {
      out.provider = requireValue(argv, ++i, arg);
    } else if (arg === "--id-only") {
      out.idOnly = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (!out.workspace) {
      out.workspace = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (out.help) return out;
  if (!out.latest && !out.workspace) {
    throw new Error("Provide a live test workspace path or use --latest [provider].");
  }
  if (out.latest && out.workspace) {
    throw new Error("Use either a workspace path or --latest, not both.");
  }
  return out;
}

function resolveWorkspace(args, tmpDir = os.tmpdir()) {
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (args.latest) {
    const latest = findLatestLiveWorkspace({ provider: args.provider, tmpDir });
    if (!latest) {
      const suffix = args.provider ? ` for provider '${args.provider}'` : "";
      throw new Error(`No live test workspace found in ${tmpDir}${suffix}.`);
    }
    return latest;
  }
  return path.resolve(args.workspace);
}

function findLatestLiveWorkspace({ provider = null, tmpDir = os.tmpdir() } = {}) {
  if (!fs.existsSync(tmpDir)) return null;
  const prefix = provider ? `live-${provider}-` : "live-";
  const candidates = fs.readdirSync(tmpDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const fullPath = path.join(tmpDir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch (_) {}
      return { fullPath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.fullPath || null;
}

function inspectLiveWorkspace(workspace) {
  const root = path.resolve(workspace);
  if (!fs.existsSync(root)) {
    throw new Error(`Live test workspace not found: ${root}`);
  }

  const coordDir = path.join(root, "coord");
  const inferred = inferWorkspaceId(root);
  const session = readJsonIfExists(path.join(coordDir, "live-test-session.json")) || {};
  const agents = readJsonIfExists(path.join(coordDir, "agents.json")) || {};
  const requests = readJsonlIfExists(path.join(coordDir, "requests.jsonl"));
  const decisions = readJsonIfExists(path.join(coordDir, "decisions.json")) || [];
  const loopPid = readTextIfExists(path.join(coordDir, "orchestrator.instance.lock", "pid"))?.trim() || null;
  const reviewStreams = findReviewStreams(coordDir);
  const logFiles = findLogFiles(coordDir, agents);
  const roles = normalizeSessionRoles(session);
  const tailCommands = buildTailCommands(session, reviewStreams, logFiles);

  return {
    workspace: root,
    session_id: session.session_id || inferred.session_id,
    provider: session.provider || inferred.provider,
    test: session.test || inferred.test,
    created_at: session.created_at || null,
    roles,
    models: session.models || {},
    coord_dir: fs.existsSync(coordDir) ? coordDir : null,
    orchestrator_pid: loopPid,
    agents: summarizeAgents(agents, coordDir),
    pending_requests: requests.filter((request) => request.status === "pending"),
    recent_decisions: Array.isArray(decisions) ? decisions.slice(-5) : [],
    review_streams: reviewStreams,
    log_files: logFiles,
    tail_commands: tailCommands,
    detections: detectKnownLiveIssues(reviewStreams, logFiles),
    commands: buildCommands(root, coordDir, loopPid, agents, reviewStreams, logFiles),
  };
}

function inferWorkspaceId(workspace) {
  const sessionId = path.basename(workspace);
  const match = sessionId.match(/^live-([^-]+)-(.+?)--.+$/);
  return {
    session_id: sessionId,
    provider: match ? match[1] : null,
    test: match ? match[2] : null,
  };
}

function summarizeAgents(agents, coordDir) {
  return Object.entries(agents || {}).map(([name, agent]) => ({
    name,
    status: agent.status || null,
    pid: agent.pid || null,
    cli: agent.cli || null,
    worktree: agent.worktree || null,
    log: coordDir ? path.join(coordDir, "logs", `${name}.log`) : null,
  }));
}

function findReviewStreams(coordDir) {
  const root = path.join(coordDir, "plan-reviews");
  if (!fs.existsSync(root)) return [];
  return walkFiles(root, 4)
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({
      path: file,
      tail: tailFile(file, 80),
    }));
}

function findLogFiles(coordDir, agents) {
  const out = [];
  const orchestratorLog = path.join(coordDir, "orchestrator.log");
  if (fs.existsSync(orchestratorLog)) {
    out.push({ label: "orchestrator", path: orchestratorLog, tail: tailFile(orchestratorLog, 80) });
  }
  for (const name of Object.keys(agents || {})) {
    const logPath = path.join(coordDir, "logs", `${name}.log`);
    if (fs.existsSync(logPath)) {
      out.push({ label: name, path: logPath, tail: tailFile(logPath, 80) });
    }
  }
  return out;
}

function normalizeSessionRoles(session) {
  if (isPlainObject(session.roles)) return session.roles;
  if (!isPlainObject(session.models)) return {};
  return Object.fromEntries(Object.entries(session.models).map(([role, model]) => [role, { model }]));
}

function detectKnownLiveIssues(reviewStreams, logFiles) {
  const detections = [];
  for (const stream of reviewStreams) {
    if (/Opening authentication page in your browser/i.test(stream.tail)) {
      detections.push({
        type: "interactive_auth_prompt",
        path: stream.path,
        message: "Provider CLI is waiting for browser authentication.",
      });
    }
  }
  for (const log of logFiles) {
    if (/failed to initialize in-process app-server client|Operation not permitted/i.test(log.tail)) {
      detections.push({
        type: "sandbox_permission_failure",
        path: log.path,
        message: "Provider CLI failed under sandbox permissions.",
      });
    }
  }
  return detections;
}

function buildTailCommands(session, reviewStreams, logFiles) {
  const commands = [];
  const seen = new Set();
  function push(label, file, command) {
    const key = command || file;
    if (!key || seen.has(key)) return;
    seen.add(key);
    commands.push({ label, path: file || null, command });
  }

  if (session && typeof session.tail_command === "string" && session.tail_command.trim() !== "") {
    push("session", null, session.tail_command.trim());
  }
  for (const stream of reviewStreams) {
    push(`reviewer ${path.basename(stream.path)}`, stream.path, `tail -F ${shellQuote(stream.path)}`);
  }
  for (const log of logFiles) {
    const label = log.label === "orchestrator" ? "orchestrator log" : `${log.label} log`;
    push(label, log.path, `tail -F ${shellQuote(log.path)}`);
  }
  return commands;
}

function buildCommands(workspace, coordDir, loopPid, agents, reviewStreams, logFiles) {
  const commands = [
    `node scripts/inspect-live-test.js ${shellQuote(workspace)}`,
  ];
  if (coordDir && fs.existsSync(coordDir)) {
    const sessionPath = path.join(coordDir, "live-test-session.json");
    const agentsPath = path.join(coordDir, "agents.json");
    if (fs.existsSync(sessionPath)) commands.push(`cat ${shellQuote(sessionPath)}`);
    if (fs.existsSync(agentsPath)) commands.push(`cat ${shellQuote(agentsPath)}`);
  }
  for (const stream of reviewStreams) {
    commands.push(`tail -n 120 ${shellQuote(stream.path)}`);
  }
  for (const log of logFiles) {
    commands.push(`tail -n 120 ${shellQuote(log.path)}`);
  }
  const pids = [loopPid, ...Object.values(agents || {}).map((agent) => agent.pid)].filter(Boolean);
  if (pids.length > 0) {
    commands.push(`ps -p ${pids.join(" -p ")} -o pid,ppid,etime,command -ww`);
  }
  return commands;
}

function formatInspection(info) {
  const lines = [
    "Live Test Inspection",
    `Workspace: ${info.workspace}`,
    `Session ID: ${info.session_id}`,
    `Provider: ${info.provider || "(unknown)"}`,
    `Test: ${info.test || "(unknown)"}`,
  ];
  if (info.created_at) lines.push(`Created: ${info.created_at}`);
  if (Object.keys(info.models || {}).length > 0) {
    lines.push(`Models: ${JSON.stringify(info.models)}`);
  }
  if (info.orchestrator_pid) lines.push(`Orchestrator PID: ${info.orchestrator_pid}`);

  const roles = Object.entries(info.roles || {});
  if (roles.length > 0) {
    lines.push("", "Role Mappings:");
    for (const [role, mapping] of roles) {
      const bits = [
        `alias=${mapping.alias || mapping.cli || "?"}`,
        `provider=${mapping.provider || "?"}`,
        `model=${mapping.model || "?"}`,
      ];
      if (mapping.provider_cli) bits.push(`provider_cli=${mapping.provider_cli}`);
      lines.push(`  ${role}: ${bits.join(" ")}`);
    }
  }

  lines.push("", "Agents:");
  if (info.agents.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const agent of info.agents) {
      lines.push(`  ${agent.name}: status=${agent.status || "unknown"} pid=${agent.pid || "?"} cli=${agent.cli || "?"}`);
      if (agent.log) lines.push(`    log: ${agent.log}`);
    }
  }

  lines.push("", `Pending requests: ${info.pending_requests.length}`);
  for (const request of info.pending_requests.slice(-5)) {
    lines.push(`  ${request.request_id || "(no id)"} agent=${request.agent || "?"} type=${request.type || "?"}`);
  }

  lines.push("", `Recent decisions: ${info.recent_decisions.length}`);
  for (const decision of info.recent_decisions) {
    lines.push(`  ${decision.request_id || "(no id)"} disposition=${decision.disposition || "?"}`);
  }

  if (info.detections.length > 0) {
    lines.push("", "Detected Issues:");
    for (const detection of info.detections) {
      lines.push(`  ${detection.type}: ${detection.message}`);
      lines.push(`    ${detection.path}`);
    }
  }

  const tailCommands = info.tail_commands || [];
  if (tailCommands.length > 0) {
    lines.push("", "Tail Commands:");
    for (const tail of tailCommands) {
      lines.push(`  ${tail.label}: ${tail.command}`);
    }
  }

  lines.push("", "Useful Commands:");
  for (const command of info.commands) lines.push(`  ${command}`);

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {
    return null;
  }
}

function readJsonlIfExists(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch (_) {
        return [];
      }
    });
}

function readTextIfExists(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  } catch (_) {
    return null;
  }
}

function tailFile(file, maxLines) {
  const text = readTextIfExists(file);
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function walkFiles(root, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/inspect-live-test.js <live-workspace>",
    "  node scripts/inspect-live-test.js --latest [provider]",
    "  node scripts/inspect-live-test.js --latest gemini --id-only",
    "",
    "Prints copyable live-test session diagnostics from a preserved /tmp live-* workspace.",
  ].join("\n");
}

module.exports = {
  findLatestLiveWorkspace,
  formatInspection,
  inferWorkspaceId,
  inspectLiveWorkspace,
  parseArgs,
};
