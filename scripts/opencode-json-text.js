#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAX_BUFFER = 20 * 1024 * 1024;

if (require.main === module) {
  const result = runOpenCodeJsonText(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}

function runOpenCodeJsonText(args, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const parsed = parseWrapperArgs(args);
  const cwd = options.cwd || parsed.cwd || findNearestGitRoot(process.cwd()) || process.cwd();
  const opencodeArgs = parsed.liveWorkerSmoke ? condenseLastPromptArg(parsed.args, cwd) : parsed.args;
  const result = spawnSyncImpl("opencode", ["run", "--format", "json", ...opencodeArgs], {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
  });

  if (result.error) {
    return {
      status: 1,
      stdout: "",
      stderr: `opencode-json-text failed to start opencode: ${result.error.message}\n`,
    };
  }

  const rawStdout = result.stdout || "";
  const extracted = extractTextFromJsonl(rawStdout);
  let stderr = result.stderr || "";
  if (!extracted.trim() && rawStdout.trim()) {
    stderr += `${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}[opencode-json-text] no text events found in opencode JSON output.\n`;
  }

  return {
    status: result.status === null || result.status === undefined ? 1 : result.status,
    stdout: extracted,
    stderr,
  };
}

function parseWrapperArgs(args) {
  const parsed = {
    args: [],
    cwd: "",
    liveWorkerSmoke: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--opencode-json-text-cwd") {
      parsed.cwd = args[++i] || "";
      continue;
    }
    if (arg === "--opencode-json-text-live-worker-smoke") {
      parsed.liveWorkerSmoke = true;
      continue;
    }
    parsed.args.push(arg);
  }
  return parsed;
}

function condenseLastPromptArg(args, cwd = "") {
  if (args.length === 0) return args;
  const out = [...args];
  const prompt = out[out.length - 1];
  if (typeof prompt === "string") {
    out[out.length - 1] = condenseWorkerPrompt(prompt, { cwd });
  }
  return out;
}

function condenseWorkerPrompt(prompt, options = {}) {
  const agent = extractLineValue(prompt, "Agent name") || "worker";
  const project = extractLineValue(prompt, "Project") || "Live worker smoke project";
  const assignment = extractSection(prompt, "Specific assignment:", "Start Here:") || prompt;
  const startHere = extractLineValue(prompt, "Start Here") || "coord/DECISIONS.md, coord/context.json";
  const worktreePath = extractLineValue(prompt, "Worktree path") || ".";
  const allowed = extractLineValue(prompt, "- **ALLOWED PATHS**") || "(use assignment paths only)";
  const forbidden = extractLineValue(prompt, "- **FORBIDDEN PATHS**") || "coord/, package.json, README.md";
  const cwd = options.cwd ? path.resolve(options.cwd) : "";
  const coordDir = cwd ? path.join(cwd, "coord") : "coord";
  const outputPath = cwd ? path.join(cwd, "live-worker-output.txt") : "live-worker-output.txt";
  const requestsDir = path.join(coordDir, "requests");
  const decisionsJson = path.join(coordDir, "decisions.json");
  const decisionsJsonl = path.join(coordDir, "decisions.jsonl");

  return [
    `You are ${agent}, a non-interactive worker for ${project}.`,
    `Current working directory is your git worktree. Worktree path from project root: ${worktreePath}.`,
    cwd ? `Actual absolute worktree path: ${cwd}.` : "",
    `Target output file: ${outputPath}.`,
    `Target requests directory: ${requestsDir}.`,
    `Decision files: ${decisionsJson} and ${decisionsJsonl}.`,
    `Reference files if needed: ${startHere}.`,
    "",
    "Follow this assignment exactly:",
    assignment.trim(),
    "",
    `Allowed implementation paths: ${allowed}.`,
    `Do not edit forbidden app paths: ${forbidden}.`,
    "Coordination writes required by the request protocol under coord/requests/ and coord/progress/ are allowed.",
    "",
    "Requests protocol:",
    "- coord/ is available in the worktree; do not create a separate coord directory outside that link.",
    `- Write request JSON files under ${requestsDir}.`,
    "- Use fields: request_id, agent, type, priority, content, status, created_at.",
    `- The agent field must be ${JSON.stringify(agent)} and status must be \"pending\".`,
    "- Use a unique request_id. For completion, type must be \"review_request\" and priority should be \"medium\".",
    `- If the assignment tells you to wait for approval, poll ${decisionsJson} and ${decisionsJsonl} until the matching request_id is approved before continuing.`,
    "- After the final review_request is written, stop changing files and return a short status.",
  ].filter(Boolean).join("\n");
}

function extractLineValue(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`^${escaped}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function extractSection(text, startMarker, endMarker) {
  const value = String(text || "");
  const start = value.indexOf(startMarker);
  if (start === -1) return "";
  const bodyStart = start + startMarker.length;
  const end = value.indexOf(endMarker, bodyStart);
  return value.slice(bodyStart, end === -1 ? undefined : end).trim();
}

function findNearestGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function extractTextFromJsonl(jsonl) {
  const chunks = [];
  for (const line of String(jsonl || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      continue;
    }

    const directText = typeof event.text === "string" ? event.text : "";
    const partText = event.part && typeof event.part.text === "string" ? event.part.text : "";
    if (event.type === "text" && (partText || directText)) {
      chunks.push(partText || directText);
    }
  }
  return chunks.join("");
}

module.exports = {
  extractTextFromJsonl,
  findNearestGitRoot,
  condenseWorkerPrompt,
  condenseLastPromptArg,
  parseWrapperArgs,
  runOpenCodeJsonText,
};
