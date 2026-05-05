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
  validateCmd?: string;
  timeoutMins?: number;
  progressTimeoutMins?: number;
  maxIterations?: number;
}

function parseArgs(): SpawnArgs {
  const args = process.argv.slice(2);
  const config: SpawnArgs = {
    validateCmd: undefined,
    timeoutMins: undefined,
    progressTimeoutMins: undefined,
    maxIterations: undefined,
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
      case "--validate":
        config.validateCmd = args[++i];
        break;
      case "--timeout":
        config.timeoutMins = parseInt(args[++i], 10);
        break;
      case "--progress-timeout":
        config.progressTimeoutMins = parseInt(args[++i], 10);
        break;
      case "--max-iterations":
        config.maxIterations = parseInt(args[++i], 10);
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


function loadConfig() {
  const configPath = require("path").join(process.cwd(), "orchestrator.config.yml");
  const parsed = {
    cli_templates: {} as Record<string, string>,
    default_timeout_mins: 10,
    default_progress_timeout_mins: 15,
    default_max_iterations: 5,
    default_cli: "kilo"
  };
  if (require("fs").existsSync(configPath)) {
    const content = require("fs").readFileSync(configPath, "utf-8");
    let inTemplates = false;
    for (let line of content.split("\n")) {
      line = line.replace(/#.*$/, "").trimRight();
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      if (trimmed.startsWith("cli_templates:")) {
        inTemplates = true;
        continue;
      }
      if (inTemplates && line.startsWith(" ") && trimmed.includes(":")) {
        const match = trimmed.match(/^([^:]+):\s*(.*)$/);
        if (match) {
            let val = match[2];
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
            parsed.cli_templates[match[1]] = val;
        }
      } else if (inTemplates && !line.startsWith(" ")) {
        inTemplates = false;
      }
      
      if (!inTemplates) {
        if (trimmed.startsWith("default_timeout_mins:")) parsed.default_timeout_mins = parseInt(trimmed.split(":")[1].trim());
        if (trimmed.startsWith("default_progress_timeout_mins:")) parsed.default_progress_timeout_mins = parseInt(trimmed.split(":")[1].trim());
        if (trimmed.startsWith("default_max_iterations:")) parsed.default_max_iterations = parseInt(trimmed.split(":")[1].trim());
        if (trimmed.startsWith("default_cli:")) parsed.default_cli = trimmed.split(":")[1].trim();
      }
    }
  }
  return parsed;
}

function spawnAgent() {
  const config = parseArgs();
  const worktreeBase = config.cli === "kilo" ? ".kilocode/worktrees" : ".agents/worktrees";
  const worktree = `${worktreeBase}/${config.agent}`;

  if (!fs.existsSync(worktree)) {
    console.error(`Error: Worktree ${worktree} does not exist. Run 'git worktree add ${worktree} -b ${config.agent}' first.`);
    process.exit(1);
  }

  const prompt = fs.readFileSync(config.promptFile, "utf-8");
  
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
    cmdArgs = ["--message-file", config.promptFile, "--yes"];
  } else if (config.cli === "claude") {
    cmd = "claude";
    cmdArgs = ["-p", prompt, "--dangerously-skip-permissions"];
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

  const parsedConfig = loadConfig();
  const cliTemplate = parsedConfig.cli_templates[config.cli];
  
  let child;
  if (cliTemplate) {
    const cmdStr = cliTemplate.replace(/\{prompt_file\}/g, config.promptFile) + (config.extraArgs.length > 0 ? " " + config.extraArgs.join(" ") : "");
    child = spawn(cmdStr, {
      detached: true,
      stdio: ["ignore", out, err],
      cwd: worktree,
      shell: true
    });
  } else {
    child = spawn(cmd, cmdArgs, {
      detached: true,
      stdio: ["ignore", out, err],
      cwd: worktree,
    });
  }

  child.unref(); // Allow the parent script to exit independently

  console.log(`✓ Spawned agent '${config.agent}' in background (PID: ${child.pid})`);
  console.log(`✓ Logging output to ${logFile}`);

  // Update agents.json
  const agentsFile = path.join(config.coordDir, "agents.json");
  let agents: any = {};
  if (fs.existsSync(agentsFile)) {
    agents = JSON.parse(fs.readFileSync(agentsFile, "utf-8"));
  }

  const existingTask = agents[config.agent]?.task || "Initial prompt";

  agents[config.agent] = {
    task: existingTask,
    status: "running",
    worktree: worktree,
    cli: config.cli,
    kilo_mode: config.mode,
    pid: child.pid,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    validate_cmd: config.validateCmd,
    timeout_mins: config.timeoutMins,
    progress_timeout_mins: config.progressTimeoutMins,
    max_iterations: config.maxIterations
  };

  fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2) + "\n");
  console.log(`✓ Registered agent in ${agentsFile}`);
}

spawnAgent();
