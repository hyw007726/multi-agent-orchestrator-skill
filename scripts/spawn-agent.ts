#!/usr/bin/env ts-node

/**
 * Spawns a Kilo Code agent in the background and registers it in coord/agents.json
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface SpawnArgs {
  agent: string;
  mode: string;
  promptFile: string;
  coordDir: string;
  cli: string;
  extraArgs: string[];
}

function parseArgs(): SpawnArgs {
  const args = process.argv.slice(2);
  const config: SpawnArgs = {
    agent: "",
    mode: "auto",
    promptFile: "",
    coordDir: "./coord",
    cli: "kilo",
    extraArgs: [],
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      config.extraArgs.push(...args.slice(i + 1));
      break;
    }
    switch (args[i]) {
      case "--agent":
        config.agent = args[++i];
        break;
      case "--mode":
        config.mode = args[++i];
        break;
      case "--prompt-file":
        config.promptFile = args[++i];
        break;
      case "--coord":
        config.coordDir = args[++i];
        break;
      case "--cli":
        config.cli = args[++i];
        break;
      default:
        // Ignore unrecognized flags if they belong to known pairs, but we already incremented `i` for known pairs.
        // Actually, to be safe, any flag not matched above that starts with "-" and isn't known will just be ignored here, 
        // but passing after `--` is the guaranteed way to forward.
        break;
    }
  }

  if (!config.agent || !config.promptFile) {
    console.error("Error: --agent and --prompt-file are required");
    process.exit(1);
  }

  return config;
}

function spawnAgent() {
  const config = parseArgs();
  const worktreeBase = config.cli === "kilo" ? ".kilocode/worktrees" : ".agents/worktrees";
  const worktree = `${worktreeBase}/${config.agent}`;

  if (!fs.existsSync(worktree)) {
    console.error(`Error: Worktree ${worktree} does not exist. Run 'git worktree add ${worktree} -b ${config.agent}' first.`);
    process.exit(1);
  }

  let prompt = fs.readFileSync(config.promptFile, "utf-8");
  prompt += "\n\nCRITICAL SYSTEM INSTRUCTION: You are running in an automated, headless environment. You MUST NOT ask the user for permission, confirmation, or interactive input at any point. Proceed with all necessary file modifications autonomously. Asking for permission will hang the system.";
  
  const logsDir = path.join(config.coordDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${config.agent}.log`);
  const out = fs.openSync(logFile, "a");
  const err = out;

  // Spawn the CLI in the background
  // Build command based on selected CLI tool
  let cmd = "kilo";
  let cmdArgs = [prompt, "--mode", config.mode, "--auto"];

  if (config.cli === "aider") {
    cmd = "aider";
    cmdArgs = ["--message", prompt, "--yes"];
  } else if (config.cli === "claude") {
    cmd = "claude";
    cmdArgs = ["-p", prompt];
  } else if (config.cli === "codex") {
    cmd = "codex";
    cmdArgs = ["--exec", prompt];
  } else if (config.cli === "gemini") {
    cmd = "gemini";
    cmdArgs = ["--prompt", prompt, "--yolo"];
  } else if (config.cli === "opencode") {
    cmd = "opencode";
    cmdArgs = ["run", prompt, "--yes"];
  }

  if (config.extraArgs.length > 0) {
    cmdArgs.push(...config.extraArgs);
  }

  const child = spawn(cmd, cmdArgs, {
    detached: true,
    stdio: ["ignore", out, err],
    cwd: worktree,
  });

  child.unref(); // Allow the parent script to exit independently

  console.log(`✓ Spawned agent '${config.agent}' in background (PID: ${child.pid})`);
  console.log(`✓ Logging output to ${logFile}`);

  // Update agents.json
  const agentsFile = path.join(config.coordDir, "agents.json");
  let agents: any = {};
  if (fs.existsSync(agentsFile)) {
    agents = JSON.parse(fs.readFileSync(agentsFile, "utf-8"));
  }

  agents[config.agent] = {
    task: "Initial prompt",
    status: "running",
    worktree: worktree,
    cli: config.cli,
    kilo_mode: config.mode,
    pid: child.pid,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };

  fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2) + "\n");
  console.log(`✓ Registered agent in ${agentsFile}`);
}

spawnAgent();
