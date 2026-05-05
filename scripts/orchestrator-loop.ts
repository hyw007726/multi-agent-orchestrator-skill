#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawnSync } from "child_process";
import { loadConfig, OrchestratorConfig } from "./lib/config";
import { safeKill } from "./lib/process";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Config {
  coordDir: string;
  pollIntervalMs: number;
  maxRetries: number;
  logFile: string;
}

interface Request {
  request_id: string;
  agent: string;
  type: "question" | "change" | "conflict" | "review_request";
  priority: "low" | "medium" | "high";
  content: string;
  status: "pending" | "resolved" | "rejected";
  created_at: string;
}

interface Decision {
  request_id: string;
  decision: string;
  reason: string;
  resolved_at: string;
}

interface AgentEntry {
  task: string;
  status: "running" | "completed" | "terminated" | "errored";
  worktree: string;
  kilo_mode: string;
  cli?: string;
  pid: number;
  started_at: string;
  last_heartbeat: string;
  validate_cmd?: string;
  timeout_mins?: number;
  progress_timeout_mins?: number;
  max_iterations?: number;
  restart_count?: number;
}

interface OrchestratorAction {
  type: "end_agent" | "soft_restart" | "hard_restart" | "restart_agent";
  agent: string;
  instruction?: string;
  rollback?: boolean;
}

interface OrchestratorResponse {
  approved: Array<{ request_id: string; decision: string; reason: string }>;
  rejected: Array<{ request_id: string; reason: string }>;
  actions: OrchestratorAction[];
}

interface ProjectContext {
  project: string;
  chat_context?: string;
  requirements: string[];
  constraints: string[];
  created_at: string;
  tasks?: Record<string, string>;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

runLoop();

async function runLoop() {
  const config = parseArgs();
  const paths = getPaths(config.coordDir);
  const parsedConfig = loadConfig();

  if (!fs.existsSync(paths.requests) || !fs.existsSync(paths.decisions) || !fs.existsSync(paths.context)) {
    console.error("Missing coordination files. Run bootstrap first.");
    process.exit(1);
  }

  const log = (msg: string) => appendLog(config.logFile, msg);
  log(`Starting Orchestrator Loop (Polling every ${config.pollIntervalMs}ms)`);
  log(`Orchestrator CLI: '${parsedConfig.orchestrator_cli}'  |  max restarts: ${parsedConfig.default_max_restarts}  |  CLI failure threshold: ${parsedConfig.claude_failure_threshold}`);

  launchDashboard(config, log);

  const agentProgress: Record<string, { last_diff: string; last_progress_time: number }> = {};
  let consecutiveCliFailures = 0;

  while (true) {
    try {
      // ── Abort flag (soft stop — preserves worktrees) ─────────────────────
      if (fs.existsSync(path.join(config.coordDir, "abort.flag"))) {
        log("🛑 ABORT SIGNAL RECEIVED. Stopping running agents (worktrees preserved)...");
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
        for (const name in agents) {
          if (agents[name].status === "running") {
            safeKill({ pid: agents[name].pid, expectedCli: agents[name].cli || "kilo", log });
            agents[name].status = "terminated";
          }
        }
        writeJSON(paths.agents, agents);
        log("All running agents stopped. Worktree contents preserved (run `git status` in each worktree to inspect/discard).");
        try { fs.unlinkSync(path.join(config.coordDir, "abort.flag")); } catch {}
        break;
      }

      // ── Per-agent liveness + progress checks ─────────────────────────────
      const agentsForCheck = readJSON<Record<string, AgentEntry>>(paths.agents);
      let agentsChanged = false;

      for (const name in agentsForCheck) {
        if (agentsForCheck[name].status !== "running") continue;
        const agent = agentsForCheck[name];

        // Process gone? Mark completed and move on.
        if (!isProcessAlive(agent.pid)) {
          agentsForCheck[name].status = "completed";
          agentsChanged = true;
          log(`ℹ️ Agent ${name} (PID ${agent.pid}) process exited.`);
          continue;
        }

        // Liveness ("Killer") timeout: no log output for `timeout_mins`.
        const logFile = path.join(config.coordDir, "logs", `${name}.log`);
        let lastActivity = new Date(agent.started_at).getTime();
        if (fs.existsSync(logFile)) lastActivity = fs.statSync(logFile).mtime.getTime();

        const timeoutMins = agent.timeout_mins || parsedConfig.default_timeout_mins;
        if (Date.now() - lastActivity > timeoutMins * 60 * 1000) {
          log(`⏱️ Agent ${name} idle (no log output) for ${timeoutMins} mins. Killing.`);
          safeKill({ pid: agent.pid, expectedCli: agent.cli || "kilo", log });
          agentsForCheck[name].status = "errored";
          agentsChanged = true;
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
          log(`⏱️ Agent ${name} stuck for ${progressMins} mins (no code changes). Triggering AI Review.`);
          const tailLines = readTail(logFile, 50);
          const reviewInstruction = generateAiReviewInstruction(tailLines, parsedConfig, log);
          log(`AI Review fix: ${reviewInstruction}`);

          const restarted = bumpRestartAndRespawn({
            name,
            agents: agentsForCheck,
            instruction: reviewInstruction,
            reason: "progress timeout",
            paths,
            parsedConfig,
            mode: "soft",
            log,
          });
          agentsChanged = true;
          if (restarted) tracker.last_progress_time = Date.now();
          continue;
        }
      }
      if (agentsChanged) writeJSON(paths.agents, agentsForCheck);

      // ── Pending requests / arbitration ───────────────────────────────────
      const requests = readJSONL<Request>(paths.requests);
      const pending = requests.filter((p) => p.status === "pending");

      if (pending.length > 0) {
        log(`Found ${pending.length} pending requests.`);
        const context = readJSON<ProjectContext>(paths.context);
        const decisions = readJSON<Decision[]>(paths.decisions);
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);

        const worktreeStates = collectWorktreeStates(pending, agents);
        const prompt = buildOrchestratorPrompt(pending, context, decisions, worktreeStates);
        const response = callOrchestratorCli(prompt, parsedConfig, config.maxRetries, log);

        if (!response) {
          consecutiveCliFailures++;
          log(`callOrchestratorCli failed (consecutive: ${consecutiveCliFailures}/${parsedConfig.claude_failure_threshold})`);
          if (consecutiveCliFailures >= parsedConfig.claude_failure_threshold) {
            writeStalledFlag(config.coordDir, consecutiveCliFailures, pending, parsedConfig, log);
          }
        } else {
          if (consecutiveCliFailures > 0) {
            consecutiveCliFailures = 0;
            clearStalledFlag(config.coordDir, log);
          }
          processActions(response.actions || [], paths, parsedConfig, log);
          processApprovals(response, paths, decisions, log);
        }
      } else {
        // ── All-done check ────────────────────────────────────────────────
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
        const entries = Object.values(agents);
        const allDone = entries.length > 0 &&
          entries.every((a) => a.status === "completed" || a.status === "terminated" || a.status === "errored");
        if (allDone) {
          finalize(config, paths, log);
          break;
        }
      }

      await sleep(config.pollIntervalMs);
    } catch (error: any) {
      log(`Loop Error: ${error.message}`);
      await sleep(config.pollIntervalMs);
    }
  }

  // ── Inner helpers ──────────────────────────────────────────────────────

  function launchDashboard(config: Config, log: (msg: string) => void) {
    try {
      const dashboardPath = path.join(__dirname, "dashboard.ts");
      if (process.platform === "darwin") {
        const scriptStr = `tell application "Terminal" to do script "cd '${process.cwd()}' && npx ts-node '${dashboardPath}' --coord '${config.coordDir}'"`;
        execSync(`osascript -e '${scriptStr}'`);
        log("Launched dashboard terminal.");
      } else {
        log(`Dashboard can be run manually in another terminal: npx ts-node '${dashboardPath}' --coord '${config.coordDir}'`);
      }
    } catch (e: any) {
      log(`Failed to launch dashboard: ${e.message}`);
    }
  }

  function processActions(
    actions: OrchestratorAction[],
    paths: ReturnType<typeof getPaths>,
    parsedConfig: OrchestratorConfig,
    log: (msg: string) => void,
  ) {
    for (const rawAction of actions) {
      // restart_agent is a legacy alias for soft_restart.
      const action: OrchestratorAction = rawAction.type === "restart_agent" ? { ...rawAction, type: "soft_restart" } : rawAction;

      if (action.type === "end_agent") {
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
        if (!agents[action.agent]) continue;
        const agent = agents[action.agent];

        const validation = runValidation(agent, log);
        if (validation.passed) {
          safeKill({ pid: agent.pid, expectedCli: agent.cli || "kilo", log });
          agents[action.agent].status = "completed";
          agents[action.agent].last_heartbeat = new Date().toISOString();
          writeJSON(paths.agents, agents);
          log(`Agent ${action.agent} completed successfully.`);
        } else {
          log(`Validation failed for ${action.agent} — converting to soft_restart.`);
          bumpRestartAndRespawn({
            name: action.agent,
            agents,
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
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
        if (!agents[action.agent]) continue;

        bumpRestartAndRespawn({
          name: action.agent,
          agents,
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

  // Mutates `agents`, writes agents.json, and respawns. Returns true if respawned.
  function bumpRestartAndRespawn(args: {
    name: string;
    agents: Record<string, AgentEntry>;
    instruction: string | undefined;
    reason: string;
    paths: ReturnType<typeof getPaths>;
    parsedConfig: OrchestratorConfig;
    mode: "soft" | "hard";
    log: (msg: string) => void;
  }): boolean {
    const { name, agents, instruction, reason, paths, parsedConfig, mode, log } = args;
    const agent = agents[name];
    if (!agent) return false;

    const cliTool = agent.cli || parsedConfig.default_cli;
    safeKill({ pid: agent.pid, expectedCli: cliTool, log });

    if (fs.existsSync(agent.worktree)) {
      if (mode === "hard") {
        const tag = captureRecoveryAndReset(agent.worktree, name, log);
        if (tag) log(`Hard restart: wiped worktree but preserved state at tag ${tag}.`);
        else log(`Hard restart: worktree was already clean.`);
      } else {
        // Soft restart: WIP-commit current work in place so respawned agent sees it.
        try {
          execSync(`git add .`, { cwd: agent.worktree });
          try {
            execSync(`git commit -m "WIP: orchestrator intervention (${reason})"`, { cwd: agent.worktree, stdio: "ignore" });
          } catch {
            log(`No changes to commit for soft_restart on ${name}.`);
          }
        } catch (err: any) {
          log(`Soft-restart WIP commit failed for ${name}: ${err.message}`);
        }
      }
    }

    if (!instruction) {
      // No new instruction means terminate, not restart.
      agents[name].status = "terminated";
      writeJSON(paths.agents, agents);
      log(`Agent ${name} terminated (no follow-up instruction).`);
      return false;
    }

    // Restart cap.
    const nextCount = (agent.restart_count ?? 0) + 1;
    const maxRestarts = parsedConfig.default_max_restarts;
    if (nextCount > maxRestarts) {
      agents[name].status = "errored";
      agents[name].task = `Exhausted ${maxRestarts} restart attempts (${reason}). Last instruction: ${instruction.slice(0, 200)}`;
      writeJSON(paths.agents, agents);
      log(`⚠️ Agent ${name} exceeded ${maxRestarts} restarts (${reason}). Marking errored, not respawning.`);
      return false;
    }

    agents[name].restart_count = nextCount;
    agents[name].task = instruction;
    writeJSON(paths.agents, agents); // persist count BEFORE spawn so spawn-agent preserves it

    const respawned = respawnAgent({ name, agent: agents[name], cliTool, instruction, paths, log });

    // spawn-agent writes its own update (pid, status="running") to agents.json.
    // Pull that fresh entry back into the caller's view so any subsequent bulk-write
    // by the iteration loop doesn't clobber the new pid/status.
    try {
      const fresh = readJSON<Record<string, AgentEntry>>(paths.agents);
      if (fresh[name]) agents[name] = fresh[name];
    } catch {}

    return respawned;
  }

  function respawnAgent(args: {
    name: string;
    agent: AgentEntry;
    cliTool: string;
    instruction: string;
    paths: ReturnType<typeof getPaths>;
    log: (msg: string) => void;
  }): boolean {
    const { name, agent, cliTool, instruction, paths, log } = args;
    const promptFile = path.join(os.tmpdir(), `prompt-${name}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, instruction, "utf-8");
    log(`Respawning agent ${name} using ${cliTool} (attempt ${agent.restart_count}/${loadConfig().default_max_restarts})...`);
    try {
      const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
      spawnSync(npxCmd, [
        "ts-node",
        path.join(__dirname, "spawn-agent.ts"),
        "--agent", name,
        "--mode", agent.kilo_mode,
        "--prompt-file", promptFile,
        "--coord", path.dirname(paths.agents),
        "--cli", cliTool,
      ], { stdio: "inherit" });
      return true;
    } catch (err: any) {
      log(`Failed to respawn agent ${name}: ${err.message}`);
      return false;
    } finally {
      try { fs.unlinkSync(promptFile); } catch {}
    }
  }

  function processApprovals(
    response: OrchestratorResponse,
    paths: ReturnType<typeof getPaths>,
    decisions: Decision[],
    log: (msg: string) => void,
  ) {
    const currentRequests = readJSONL<Request>(paths.requests);
    let modified = false;

    for (const approved of response.approved || []) {
      const req = currentRequests.find((p) => p.request_id === approved.request_id);
      if (req) {
        req.status = "resolved";
        modified = true;
        decisions.push({
          request_id: approved.request_id,
          decision: approved.decision,
          reason: approved.reason,
          resolved_at: new Date().toISOString(),
        });
        log(`Approved Request ${approved.request_id}: ${approved.decision}`);
      }
    }
    for (const rejected of response.rejected || []) {
      const req = currentRequests.find((p) => p.request_id === rejected.request_id);
      if (req) {
        req.status = "rejected";
        modified = true;
        log(`Rejected Request ${rejected.request_id}: ${rejected.reason}`);
      }
    }
    if (decisions.length > 30) {
      log(`Archiving ${decisions.length - 30} old decisions to save tokens.`);
      decisions.splice(0, decisions.length - 30);
    }
    if (modified) writeJSONL(paths.requests, currentRequests);
    writeJSON(paths.decisions, decisions);
  }
}

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    coordDir: "./coord",
    pollIntervalMs: 5000,
    maxRetries: 3,
    logFile: "coord/orchestrator.log",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--coord") config.coordDir = args[++i];
    if (args[i] === "--poll-interval") config.pollIntervalMs = parseInt(args[++i], 10);
  }
  return config;
}

function getPaths(coordDir: string) {
  return {
    requests: path.join(coordDir, "requests.jsonl"),
    decisions: path.join(coordDir, "decisions.json"),
    context: path.join(coordDir, "context.json"),
    agents: path.join(coordDir, "agents.json"),
  };
}

// ─── IO helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function readJSONL<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

function writeJSON<T>(filePath: string, data: T): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function writeJSONL<T>(filePath: string, data: T[]): void {
  const content = data.map((item) => JSON.stringify(item)).join("\n") + (data.length > 0 ? "\n" : "");
  fs.writeFileSync(filePath, content);
}

function appendLog(logFile: string, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, line);
  console.log(line.trim());
}

// ─── Process / git helpers ───────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readDiffSnapshot(worktree: string): string {
  if (!fs.existsSync(worktree)) return "";
  try {
    const unstaged = execSync("git diff --stat", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const staged = execSync("git diff --staged --stat", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const commits = execSync("git log -n 5 --oneline", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return `${unstaged}\n${staged}\n${commits}`;
  } catch { return ""; }
}

function readTail(filePath: string, lines: number): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    return execSync(`tail -n ${lines} "${filePath}"`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}

// Captures uncommitted+untracked state in a recovery tag, then resets the worktree.
// Returns the tag name on success, or null if nothing was preserved.
function captureRecoveryAndReset(worktree: string, agent: string, log: (msg: string) => void): string | null {
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
    } catch (err: any) {
      log(`Recovery staging failed: ${err.message}`);
    }

    let tag: string | null = null;
    if (createdRecovery) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      tag = `recovery/${agent}/${ts}`;
      try {
        execSync(`git tag "${tag}"`, { cwd: worktree, stdio: "ignore" });
      } catch (err: any) {
        log(`Failed to create recovery tag: ${err.message}`);
        tag = null;
      }
    }

    execSync(`git reset --hard ${headBefore}`, { cwd: worktree, stdio: "ignore" });
    execSync("git clean -fd", { cwd: worktree, stdio: "ignore" });
    return tag;
  } catch (err: any) {
    log(`Hard reset failed: ${err.message}`);
    return null;
  }
}

function runValidation(agent: AgentEntry, log: (msg: string) => void): { passed: boolean; log: string } {
  if (!agent.validate_cmd || agent.validate_cmd === "null") return { passed: true, log: "" };
  log(`Running validation: ${agent.validate_cmd}`);
  try {
    execSync(agent.validate_cmd, { cwd: agent.worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    log(`Validation passed.`);
    return { passed: true, log: "" };
  } catch (err: any) {
    const out = (err.stdout || "") + "\n" + (err.stderr || err.message || "");
    log(`Validation failed.`);
    return { passed: false, log: out };
  }
}

function collectWorktreeStates(pending: Request[], agents: Record<string, AgentEntry>): Record<string, string> {
  const states: Record<string, string> = {};
  for (const req of pending) {
    if (states[req.agent] || !agents[req.agent]) continue;
    const worktree = agents[req.agent].worktree;
    if (!fs.existsSync(worktree)) continue;
    try {
      const status = execSync("git status -s", { cwd: worktree, encoding: "utf-8" });
      let baseBranch = "main";
      try {
        const wtList = execSync("git worktree list", { cwd: worktree, encoding: "utf-8" });
        const match = wtList.match(/\[(.*?)\]/);
        if (match && match[1]) baseBranch = match[1];
      } catch { baseBranch = "master"; }

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
    } catch (err: any) {
      states[req.agent] = `Failed to read worktree state: ${err.message}`;
    }
  }
  return states;
}

// ─── Orchestrator CLI invocation ─────────────────────────────────────────────

// Builds the arbitration prompt sent to the orchestrator CLI for each pending-request cycle.
function buildOrchestratorPrompt(
  requests: Request[],
  context: ProjectContext,
  decisions: Decision[],
  worktreeStates: Record<string, string>,
): string {
  return `You are the system orchestrator for a multi-agent project.

Worker agents are running as headless CLI sessions, each in an isolated git worktree.
They communicate by appending requests to coord/requests.jsonl.

## Project Context
${JSON.stringify(context, null, 2)}

## Existing Decisions (DO NOT contradict these)
${JSON.stringify(decisions, null, 2)}

## Agent Worktree States (Code Context)
Here is the current git status and diff for the agents that submitted requests. Use this code context to understand their progress and evaluate their requests:
${JSON.stringify(worktreeStates, null, 2)}

## New Requests from Agents
${JSON.stringify(requests, null, 2)}

## Your Responsibilities
- Maintain consistency across all agent sessions
- Resolve requests without contradicting existing decisions
- Prevent conflicts between agents working in parallel worktrees
- Prefer minimal disruption to running sessions
- Reject unclear requests — ask for clarification rather than guessing
- **IMPORTANT**: Every request you process MUST be explicitly included in either the \`approved\` or \`rejected\` array. Even if you issue an action (like \`end_agent\`), you MUST STILL approve the request that triggered it so it is marked as resolved.

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
`;
}

// Calls the orchestrator CLI for arbitration. Honors `orchestrator_cli` + `cli_templates`
// in orchestrator.config.yml so monitoring runs through a configurable (often cheap) model,
// matching the "background monitoring loops extremely cheap" claim in SKILL.md.
function callOrchestratorCli(
  prompt: string,
  parsedConfig: OrchestratorConfig,
  maxRetries: number,
  log: (msg: string) => void,
): OrchestratorResponse | null {
  const cli = parsedConfig.orchestrator_cli;
  const template = parsedConfig.cli_templates[cli];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`Calling orchestrator CLI '${cli}' (attempt ${attempt}/${maxRetries})...`);
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
    } catch (err: any) {
      log(`JSON parse failed: ${err.message}`);
      if (attempt === maxRetries) return null;
    }
  }
  return null;

  // Single-use helper — only called from the retry loop above.
  function invokeOrchestratorCli(cli: string, template: string | undefined, prompt: string): { stdout: string; error?: string } {
    if (template) {
      const promptFile = path.join(os.tmpdir(), `orch-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, "utf-8");
      try {
        const cmdStr = template.replace(/\{prompt_file\}/g, promptFile);
        const result = spawnSync(cmdStr, { shell: true, encoding: "utf-8", maxBuffer: 1024 * 1024 * 10 });
        if (result.error) return { stdout: "", error: result.error.message };
        if (result.status !== 0) return { stdout: result.stdout || "", error: `Exit ${result.status}: ${result.stderr}` };
        return { stdout: result.stdout || "" };
      } finally {
        try { fs.unlinkSync(promptFile); } catch {}
      }
    }
    // Fallback for an `orchestrator_cli` with no template — assume it accepts `-p <prompt>`.
    const result = spawnSync(cli, ["-p", prompt], { encoding: "utf-8", maxBuffer: 1024 * 1024 * 10 });
    if (result.error) return { stdout: "", error: result.error.message };
    if (result.status !== 0) return { stdout: result.stdout || "", error: `Exit ${result.status}: ${result.stderr}` };
    return { stdout: result.stdout || "" };
  }
}

function generateAiReviewInstruction(tailLogs: string, parsedConfig: OrchestratorConfig, log: (msg: string) => void): string {
  const reviewPrompt = `This agent is stuck. Look at its last 50 lines of logs:\n\n${tailLogs}\n\nWhat is it failing to understand? Write a 1-sentence instruction I can send it to break it out of this loop.`;
  const cli = parsedConfig.default_cli;
  const template = parsedConfig.cli_templates[cli];
  const promptFile = path.join(os.tmpdir(), `review-prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, reviewPrompt, "utf-8");
  try {
    if (template) {
      const cmdStr = template.replace(/\{prompt_file\}/g, promptFile);
      const result = spawnSync(cmdStr, { shell: true, encoding: "utf-8", timeout: 60000 });
      if (result.stdout?.trim()) return result.stdout.trim();
    } else {
      const result = spawnSync("claude", ["-p", reviewPrompt, "--dangerously-skip-permissions"], { encoding: "utf-8", timeout: 60000 });
      if (result.stdout?.trim()) return result.stdout.trim();
    }
  } catch (e: any) {
    log(`Triggered AI Review failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
  return "You seem stuck. Please review the logs and continue.";
}

// ─── Stalled-flag handling ───────────────────────────────────────────────────

function writeStalledFlag(
  coordDir: string,
  consecutiveFailures: number,
  pending: Request[],
  parsedConfig: OrchestratorConfig,
  log: (msg: string) => void,
): void {
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
    log(`⚠️  Wrote stalled flag (${stalledFlag}). Dashboard will surface this until the CLI recovers.`);
  } catch (err: any) {
    log(`Failed to write stalled flag: ${err.message}`);
  }
}

function clearStalledFlag(coordDir: string, log: (msg: string) => void): void {
  const stalledFlag = path.join(coordDir, "orchestrator-stalled.flag");
  if (fs.existsSync(stalledFlag)) {
    try {
      fs.unlinkSync(stalledFlag);
      log("Cleared stalled flag — orchestrator CLI recovered.");
    } catch {}
  }
}

// ─── Final summary phase ─────────────────────────────────────────────────────

function finalize(config: Config, paths: ReturnType<typeof getPaths>, log: (msg: string) => void) {
  log("All worker agents completed. Spawning worker session for review summary...");
  const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
  const summaries: string[] = [];
  let workerCli = "kilo";
  let baseBranch = "main";

  for (const name in agents) {
    const a = agents[name];
    if (a.cli) workerCli = a.cli;
    if (fs.existsSync(a.worktree)) {
      try {
        const wtList = execSync("git worktree list", { cwd: a.worktree, encoding: "utf-8" });
        const match = wtList.match(/\[(.*?)\]/);
        if (match && match[1]) baseBranch = match[1];
      } catch {}
    }
    summaries.push(`- Agent: ${name}\n  Status: ${a.status}\n  Task: ${a.task}\n  Branch: ${name}`);
  }

  const agentsList = summaries.join("\n\n");
  const summaryFile = path.join(config.coordDir, "review-summary.txt");
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

  const { cmd, cmdArgs } = workerCliCommand(workerCli, shortPrompt, promptFile);
  let summaryOutput = "";
  try {
    log(`Calling ${workerCli} for review summary...`);
    const result = spawnSync(cmd, cmdArgs, { encoding: "utf-8", maxBuffer: 1024 * 1024 * 10, timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${workerCli} exited with status ${result.status}: ${result.stderr}`);
    summaryOutput = result.stdout;
    fs.writeFileSync(summaryFile, summaryOutput, "utf-8");
    log(`Review summary generated by ${workerCli}.`);
  } catch (err: any) {
    log(`Worker review failed (${err.message}). Writing raw stats fallback.`);
    summaryOutput = `ALL AGENTS COMPLETED\n\n${agentsList}\n\nNext: return to your Claude session and say "The agents are done. Please review and integrate their work."`;
    fs.writeFileSync(summaryFile, summaryOutput, "utf-8");
  }
  try { fs.unlinkSync(promptFile); } catch {}

  try {
    if (process.platform === "darwin") {
      const script = `tell application "Terminal" to do script "cat '${summaryFile}'; echo; echo 'Press any key to close...'; read -n 1"`;
      execSync(`osascript -e '${script}'`);
    } else if (process.platform === "win32") {
      execSync(`start cmd /k "type ${summaryFile}"`, { shell: "cmd.exe" });
    } else {
      execSync(`x-terminal-emulator -e "cat '${summaryFile}'; read -p 'Press Enter to close...'" || xterm -e "cat '${summaryFile}'; read -p 'Press Enter to close...'"`, { shell: "/bin/bash" });
    }
    log("Opened review summary in new terminal window.");
  } catch (err: any) {
    log(`Could not open new terminal: ${err.message}. Printing summary inline.`);
    console.log("\n" + summaryOutput + "\n");
  }
  log("Orchestrator loop ending.");

  // Single-use helper — used only by `finalize`.
  function workerCliCommand(workerCli: string, shortPrompt: string, promptFile: string): { cmd: string; cmdArgs: string[] } {
    switch (workerCli) {
      case "aider":    return { cmd: "aider",    cmdArgs: ["--message-file", promptFile, "--yes"] };
      case "claude":   return { cmd: "claude",   cmdArgs: ["-p", shortPrompt, "--dangerously-skip-permissions"] };
      case "codex":    return { cmd: "codex",    cmdArgs: ["--exec", shortPrompt] };
      case "gemini":   return { cmd: "gemini",   cmdArgs: ["--prompt", shortPrompt, "--yolo"] };
      case "opencode": return { cmd: "opencode", cmdArgs: ["run", shortPrompt, "--yes"] };
      default:         return { cmd: "kilo",     cmdArgs: [shortPrompt, "--mode", "code", "--auto"] };
    }
  }
}
