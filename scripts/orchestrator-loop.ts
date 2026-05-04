#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Config {
  coordDir: string;
  pollIntervalMs: number;
  claudeModel: string;
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
}

interface OrchestratorAction {
  type: "end_agent" | "restart_agent";
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

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function readJSONL<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => JSON.parse(line));
}

function writeJSON<T>(filePath: string, data: T): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function writeJSONL<T>(filePath: string, data: T[]): void {
  const content = data.map(item => JSON.stringify(item)).join("\n") + (data.length > 0 ? "\n" : "");
  fs.writeFileSync(filePath, content);
}

function appendLog(logFile: string, message: string): void {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, logMsg);
  console.log(logMsg.trim());
}

function killAgentProcess(pid: number, logFile: string) {
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      appendLog(logFile, `Sent SIGTERM to agent process PID ${pid}.`);
    } catch (err: any) {
      if (err.code === "ESRCH") {
        appendLog(logFile, `Agent process PID ${pid} already exited.`);
      } else {
        appendLog(logFile, `Failed to kill agent PID ${pid}: ${err.message}`);
      }
    }
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    coordDir: "./coord",
    pollIntervalMs: 5000,
    claudeModel: "claude-3-7-sonnet-20250219",
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

// ─── Claude CLI Integration ──────────────────────────────────────────────────

function buildOrchestratorPrompt(
  requests: Request[],
  context: ProjectContext,
  decisions: Decision[],
  worktreeStates: Record<string, string>
): string {
  return `You are the system orchestrator for a multi-agent project using Kilo Code.

Worker agents are running as Kilo Code sessions, each in an isolated git worktree.
They communicate by writing requests to coord/requests.json.

## Project Context
${JSON.stringify(context, null, 2)}

## Existing Decisions (DO NOT contradict these)
${JSON.stringify(decisions, null, 2)}

## Agent Worktree States (Code Context)
Here is the current git status and diff for the agents that submitted requests. Use this code context to understand their progress and evaluate their requests:
${JSON.stringify(worktreeStates, null, 2)}

## New Requests from Kilo Agents
${JSON.stringify(requests, null, 2)}

## Your Responsibilities
- Maintain consistency across all Kilo agent sessions
- Resolve requests without contradicting existing decisions
- Prevent conflicts between agents working in parallel worktrees
- Prefer minimal disruption to running Kilo sessions
- Reject unclear requests — ask for clarification rather than guessing
- **IMPORTANT**: Every request you process MUST be explicitly included in either the \`approved\` or \`rejected\` array. Even if you issue an action (like \`end_agent\`), you MUST STILL approve the request that triggered it so it is marked as resolved.

## Response Format
Return ONLY valid JSON matching this exact structure (no markdown, no explanation):
{
  "approved": [
    {
      "request_id": "...",
      "decision": "clear statement of what was decided",
      "reason": "why this decision was made"
    }
  ],
  "rejected": [
    {
      "request_id": "...",
      "reason": "why this was rejected"
    }
  ],
  "actions": [
    {
      "type": "end_agent | restart_agent",
      "agent": "agent-name",
      "instruction": "optional — new instructions for the Kilo session",
      "rollback": false
    }
  ]
}
`;
}

function callClaude(prompt: string, model: string, maxRetries: number, logFile: string): OrchestratorResponse | null {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      appendLog(logFile, `Calling Claude (Attempt ${attempt}/${maxRetries})...`);
      const result = require("child_process").spawnSync("claude", ["-p", prompt], { encoding: "utf-8", maxBuffer: 1024 * 1024 * 10 });
      
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Claude exited with status ${result.status}: ${result.stderr}`);
      const stdout = result.stdout;
      
      const match = stdout.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON object found in Claude output.");

      const parsed = JSON.parse(match[0]);
      appendLog(logFile, `Claude call succeeded.`);
      return parsed;
    } catch (err: any) {
      appendLog(logFile, `Claude call failed: ${err.message}`);
      if (attempt === maxRetries) {
        appendLog(logFile, "Max retries reached. Returning null.");
        return null;
      }
    }
  }
  return null;
}

// ─── Loop Execution ──────────────────────────────────────────────────────────

async function runLoop() {
  const config = parseArgs();
  const paths = getPaths(config.coordDir);

  if (!fs.existsSync(paths.requests) || !fs.existsSync(paths.decisions) || !fs.existsSync(paths.context)) {
    console.error("Missing coordination files. Run bootstrap first.");
    process.exit(1);
  }

  appendLog(config.logFile, `Starting Orchestrator Loop (Polling every ${config.pollIntervalMs}ms)`);

  // Launch the live dashboard in a new macOS Terminal if applicable
  try {
    const dashboardPath = path.join(__dirname, "dashboard.ts");
    if (process.platform === "darwin") {
      const scriptStr = `tell application "Terminal" to do script "cd '${process.cwd()}' && npx ts-node '${dashboardPath}' --coord '${config.coordDir}'"`;
      execSync(`osascript -e '${scriptStr}'`);
      appendLog(config.logFile, "Launched dashboard terminal.");
    } else {
      appendLog(config.logFile, `Dashboard can be run manually in another terminal: npx ts-node '${dashboardPath}' --coord '${config.coordDir}'`);
    }
  } catch (e: any) {
    appendLog(config.logFile, `Failed to launch dashboard: ${e.message}`);
  }

  while (true) {
    try {
      if (fs.existsSync(path.join(config.coordDir, "abort.flag"))) {
        appendLog(config.logFile, "🛑 ABORT SIGNAL RECEIVED from dashboard. Terminating all agents...");
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
        for (const name in agents) {
          if (agents[name].status === "running") {
            killAgentProcess(agents[name].pid, config.logFile);
            const worktree = agents[name].worktree;
            if (fs.existsSync(worktree)) {
              appendLog(config.logFile, `Resetting worktree ${worktree}...`);
              try { execSync(`git reset --hard HEAD && git clean -fd`, { cwd: worktree }); } catch(e) {}
            }
            agents[name].status = "errored";
            agents[name].task = "ABORTED BY USER";
          }
        }
        writeJSON(paths.agents, agents);
        appendLog(config.logFile, "All agents terminated and reset. Orchestrator loop aborting.");
        try { fs.unlinkSync(path.join(config.coordDir, "abort.flag")); } catch (e) {}
        break;
      }

      // Check for crashed agents (e.g. network failures)
      const agentsForCheck = readJSON<Record<string, AgentEntry>>(paths.agents);
      let agentsChanged = false;
      const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

      for (const name in agentsForCheck) {
        if (agentsForCheck[name].status === "running") {
          try {
            process.kill(agentsForCheck[name].pid, 0); // 0 signal tests if process is alive
            
            // Check for log file idle timeout (detects hanging agents)
            const logFile = path.join(config.coordDir, "logs", `${name}.log`);
            let lastActivity = new Date(agentsForCheck[name].started_at).getTime();
            if (fs.existsSync(logFile)) {
              lastActivity = fs.statSync(logFile).mtime.getTime();
            }
            
            if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
              appendLog(config.logFile, `⏱️ Agent ${name} has been idle (no log output) for 3 minutes. Killing process.`);
              killAgentProcess(agentsForCheck[name].pid, config.logFile);
              agentsForCheck[name].status = "errored";
              agentsChanged = true;
            }
          } catch (e) {
            agentsForCheck[name].status = "errored";
            agentsChanged = true;
            appendLog(config.logFile, `⚠️ Agent ${name} (PID ${agentsForCheck[name].pid}) died unexpectedly!`);
          }
        }
      }
      if (agentsChanged) writeJSON(paths.agents, agentsForCheck);

      const requests = readJSONL<Request>(paths.requests);
      const pending = requests.filter((p) => p.status === "pending");

      if (pending.length > 0) {
        appendLog(config.logFile, `Found ${pending.length} pending requests.`);

        const context = readJSON<ProjectContext>(paths.context);
        const decisions = readJSON<Decision[]>(paths.decisions);
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);

        const worktreeStates: Record<string, string> = {};
        for (const req of pending) {
          if (!worktreeStates[req.agent] && agents[req.agent]) {
            const worktree = agents[req.agent].worktree;
            if (fs.existsSync(worktree)) {
              try {
                const status = execSync('git status -s', { cwd: worktree, encoding: 'utf-8' });
                
                let baseBranch = "main";
                try { execSync('git show-ref --verify refs/heads/main', { cwd: worktree, stdio: 'ignore' }); } 
                catch { baseBranch = "master"; }
                
                const diffUnstaged = execSync('git diff', { cwd: worktree, encoding: 'utf-8' });
                const diffStaged = execSync('git diff --staged', { cwd: worktree, encoding: 'utf-8' });
                const diffBranch = execSync(`git diff ${baseBranch}...HEAD`, { cwd: worktree, encoding: 'utf-8' });
                worktreeStates[req.agent] = `STATUS:\n${status}\n\nDIFF UNSTAGED:\n${diffUnstaged.slice(0, 5000)}\n\nDIFF STAGED:\n${diffStaged.slice(0, 5000)}\n\nCOMMITS against ${baseBranch}:\n${diffBranch.slice(0, 10000)}`;
              } catch (err: any) {
                worktreeStates[req.agent] = `Failed to read worktree state: ${err.message}`;
              }
            }
          }
        }

        const prompt = buildOrchestratorPrompt(pending, context, decisions, worktreeStates);
        const response = callClaude(prompt, config.claudeModel, config.maxRetries, config.logFile);

        if (!response) {
          appendLog(config.logFile, "Skipping cycle due to Claude failure.");
        } else {
          // Process Actions
          // Re-read agents.json to avoid overwriting agents that were spawned while Claude was processing
          const latestAgents = readJSON<Record<string, AgentEntry>>(paths.agents);

          for (const action of response.actions || []) {
            switch (action.type) {
              case "end_agent": {
                if (latestAgents[action.agent]) {
                  killAgentProcess(latestAgents[action.agent].pid, config.logFile);
                  latestAgents[action.agent].status = "completed";
                  latestAgents[action.agent].last_heartbeat = new Date().toISOString();
                  appendLog(config.logFile, `Agent ${action.agent} completed successfully.`);
                }
                break;
              }
              case "restart_agent": {
                if (latestAgents[action.agent]) {
                  const worktree = latestAgents[action.agent].worktree;
                  const mode = latestAgents[action.agent].kilo_mode;
                  killAgentProcess(latestAgents[action.agent].pid, config.logFile);
                  
                  if (action.rollback && fs.existsSync(worktree)) {
                    appendLog(config.logFile, `Rolling back worktree ${worktree}...`);
                    try {
                      execSync(`git reset --hard HEAD && git clean -fd`, { cwd: worktree });
                    } catch (err: any) {
                      appendLog(config.logFile, `Rollback failed: ${err.message}`);
                    }
                  }
                  
                  if (action.instruction) {
                    latestAgents[action.agent].task = action.instruction;
                    const promptFile = path.join(require("os").tmpdir(), `prompt-${action.agent}-${Date.now()}.txt`);
                    fs.writeFileSync(promptFile, action.instruction, "utf-8");
                    
                    const cliTool = latestAgents[action.agent].cli || "kilo";
                    appendLog(config.logFile, `Respawning agent ${action.agent} using ${cliTool}...`);
                    try {
                      writeJSON(paths.agents, latestAgents); // Ensure spawn-agent.ts sees the updated task
                      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
                      require("child_process").spawnSync(npxCmd, [
                        "ts-node",
                        path.join(__dirname, "spawn-agent.ts"),
                        "--agent", action.agent,
                        "--mode", mode,
                        "--prompt-file", promptFile,
                        "--coord", path.dirname(paths.agents),
                        "--cli", cliTool
                      ], { stdio: 'inherit' });
                      
                      // Fetch the new PID and timestamps from the updated disk file
                      const diskAgents = readJSON<Record<string, AgentEntry>>(paths.agents);
                      if (diskAgents[action.agent]) {
                        latestAgents[action.agent].pid = diskAgents[action.agent].pid;
                        latestAgents[action.agent].status = diskAgents[action.agent].status;
                        latestAgents[action.agent].started_at = diskAgents[action.agent].started_at;
                        latestAgents[action.agent].last_heartbeat = diskAgents[action.agent].last_heartbeat;
                      }
                    } catch (err: any) {
                      appendLog(config.logFile, `Failed to respawn agent: ${err.message}`);
                    }
                    try { fs.unlinkSync(promptFile); } catch {}
                  } else {
                    latestAgents[action.agent].status = "terminated";
                    appendLog(config.logFile, `Agent ${action.agent} terminated.`);
                  }
                }
                break;
              }
            }
          }

          // Re-read requests to avoid overwriting any new ones that arrived during the Claude call or action processing
          const latestRequests = readJSONL<Request>(paths.requests);
          
          // Process Approved
          for (const approved of response.approved || []) {
            const req = latestRequests.find((p) => p.request_id === approved.request_id);
            if (req) {
              req.status = "resolved";
              decisions.push({
                request_id: approved.request_id,
                decision: approved.decision,
                reason: approved.reason,
                resolved_at: new Date().toISOString(),
              });
              appendLog(config.logFile, `Approved Request ${approved.request_id}: ${approved.decision}`);
            }
          }

          // Process Rejected
          for (const rejected of response.rejected || []) {
            const req = latestRequests.find((p) => p.request_id === rejected.request_id);
            if (req) {
              req.status = "rejected";
              appendLog(config.logFile, `Rejected Request ${rejected.request_id}: ${rejected.reason}`);
            }
          }

          if (decisions.length > 30) {
            appendLog(config.logFile, `Archiving ${decisions.length - 30} old decisions to save tokens.`);
            decisions.splice(0, decisions.length - 30);
          }

          writeJSONL(paths.requests, latestRequests);
          writeJSON(paths.decisions, decisions);
          writeJSON(paths.agents, latestAgents);
        }
      } else {
        const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
        const agentEntries = Object.values(agents);
        const allWorkersDone = agentEntries.length > 0 &&
          agentEntries.every(
            (a) => a.status === "completed" || a.status === "terminated" || a.status === "errored"
          );

        if (allWorkersDone) {
          appendLog(config.logFile, "All worker agents completed. Spawning worker session for review summary...");

          // Collect diffs and stats from all completed agents
          const agents = readJSON<Record<string, AgentEntry>>(paths.agents);
          const diffSections: string[] = [];
          let workerCli = "kilo";

          for (const name in agents) {
            const a = agents[name];
            if (a.cli) workerCli = a.cli;

            const worktree = a.worktree;
            if (fs.existsSync(worktree)) {
              try {
                let baseBranch = "main";
                try { execSync('git show-ref --verify refs/heads/main', { cwd: worktree, stdio: 'ignore' }); }
                catch { baseBranch = "master"; }

                const stat = execSync(`git diff ${baseBranch}...${name} --stat`, { encoding: 'utf-8' }).trim();
                const diff = execSync(`git diff ${baseBranch}...${name}`, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 5 });
                diffSections.push(`Agent: ${name} [${a.status}]\nTask: ${a.task}\n\nChanged Files:\n${stat}\n\nDiff (truncated):\n${diff.slice(0, 5000)}`);
              } catch (err: any) {
                diffSections.push(`Agent: ${name} [${a.status}]\nTask: ${a.task}\nFailed to read diff: ${err.message}`);
              }
            } else {
              diffSections.push(`Agent: ${name} [${a.status}]\nTask: ${a.task}\n(worktree not found)`);
            }
          }

          const allDiffs = diffSections.join("\n\n---\n\n");
          const summaryFile = path.join(config.coordDir, "review-summary.txt");

          // Build the review prompt for the worker agent
          const reviewPrompt = `You are reviewing the completed output of a multi-agent coding project. Each agent worked in an isolated git worktree. Write a concise plain-text summary suitable for display in a terminal window. Include: 1) A 2-3 sentence executive summary. 2) For each agent: a bullet summarizing what was built and any concerns. 3) A short Merge Order recommendation. Keep the total output under 50 lines. Be direct. Here are the diffs:\n\n${allDiffs}`;
          const promptFile = path.join(os.tmpdir(), `review-prompt-${Date.now()}.txt`);
          fs.writeFileSync(promptFile, reviewPrompt, "utf-8");

          // Call the same worker CLI that the agents used
          let cmd = "kilo";
          let cmdArgs = [fs.readFileSync(promptFile, "utf-8"), "--mode", "code", "--auto"];

          switch (workerCli) {
            case "aider":
              cmd = "aider";
              cmdArgs = ["--message-file", promptFile, "--yes"];
              break;
            case "claude":
              cmd = "claude";
              cmdArgs = ["-p", fs.readFileSync(promptFile, "utf-8"), "--dangerously-skip-permissions"];
              break;
            case "codex":
              cmd = "codex";
              cmdArgs = ["--exec", fs.readFileSync(promptFile, "utf-8")];
              break;
            case "gemini":
              cmd = "gemini";
              cmdArgs = ["--prompt", fs.readFileSync(promptFile, "utf-8"), "--yolo"];
              break;
            case "opencode":
              cmd = "opencode";
              cmdArgs = ["run", fs.readFileSync(promptFile, "utf-8"), "--yes"];
              break;
          }

          let summaryOutput = "";
          try {
            appendLog(config.logFile, `Calling ${workerCli} for review summary...`);
            const result = require("child_process").spawnSync(cmd, cmdArgs, {
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024 * 10,
              timeout: 120000,
            });
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(`${workerCli} exited with status ${result.status}: ${result.stderr}`);
            summaryOutput = result.stdout;
            fs.writeFileSync(summaryFile, summaryOutput, "utf-8");
            appendLog(config.logFile, `Review summary generated by ${workerCli}.`);
          } catch (err: any) {
            appendLog(config.logFile, `Worker review failed (${err.message}). Writing raw stats fallback.`);
            summaryOutput = `ALL AGENTS COMPLETED\n\n${allDiffs}\n\nNext: return to your Claude session and say "The agents are done. Please review and integrate their work."`;
            fs.writeFileSync(summaryFile, summaryOutput, "utf-8");
          }

          try { fs.unlinkSync(promptFile); } catch {}

          // Open summary in a new terminal window (cross-platform)
          try {
            if (process.platform === "darwin") {
              const script = `tell application "Terminal" to do script "cat '${summaryFile}'; echo; echo 'Press any key to close...'; read -n 1"`;
              execSync(`osascript -e '${script}'`);
            } else if (process.platform === "win32") {
              execSync(`start cmd /k "type ${summaryFile}"`, { shell: "cmd.exe" });
            } else {
              execSync(`x-terminal-emulator -e "cat '${summaryFile}'; read -p 'Press Enter to close...'" || xterm -e "cat '${summaryFile}'; read -p 'Press Enter to close...'"`, { shell: "/bin/bash" });
            }
            appendLog(config.logFile, "Opened review summary in new terminal window.");
          } catch (err: any) {
            appendLog(config.logFile, `Could not open new terminal: ${err.message}. Printing summary inline.`);
            console.log("\n" + summaryOutput + "\n");
          }

          appendLog(config.logFile, "Orchestrator loop ending.");
          break;
        }
      }

      await sleep(config.pollIntervalMs);
    } catch (error: any) {
      appendLog(config.logFile, `Loop Error: ${error.message}`);
      await sleep(config.pollIntervalMs);
    }
  }
}

runLoop();
