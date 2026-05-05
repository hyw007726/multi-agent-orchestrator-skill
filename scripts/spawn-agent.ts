#!/usr/bin/env ts-node

/**
 * Spawns a worker CLI agent in the background and registers it in coord/agents.json.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./lib/config";

interface SpawnArgs {
  agent: string;
  mode: string;
  promptFile: string;
  coordDir: string;
  cli: string;
  extraArgs: string[];
  validateCmd?: string | string[];
  timeoutMins?: number;
  progressTimeoutMins?: number;
  maxIterations?: number;
}

spawnAgent();

function spawnAgent() {
  const config = parseArgs();
  const parsedConfig = loadConfig();

  const worktreeBase = config.cli === "kilo" ? ".kilocode/worktrees" : ".agents/worktrees";
  const worktree = path.resolve(process.cwd(), worktreeBase, config.agent);

  if (!fs.existsSync(worktree)) {
    console.error(`Error: Worktree ${worktree} does not exist. Run 'git worktree add ${path.relative(process.cwd(), worktree)} -b ${config.agent}' first.`);
    process.exit(1);
  }

  const prompt = fs.readFileSync(config.promptFile, "utf-8");

  const logsDir = path.resolve(config.coordDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${config.agent}.log`);
  const out = fs.openSync(logFile, "a");
  const err = out;

  const cliTemplate = parsedConfig.cli_templates[config.cli];

  let child;
  if (cliTemplate) {
    const cmdStr = cliTemplate.replace(/\{prompt_file\}/g, config.promptFile)
      + (config.extraArgs.length > 0 ? " " + config.extraArgs.join(" ") : "");
    child = spawn(cmdStr, {
      detached: true,
      stdio: ["ignore", out, err],
      cwd: worktree,
      shell: true,
    });
  } else {
    const { cmd, cmdArgs } = builtinCli(config.cli, prompt, config.promptFile, config.mode, config.extraArgs);
    child = spawn(cmd, cmdArgs, {
      detached: true,
      stdio: ["ignore", out, err],
      cwd: worktree,
    });
  }

  child.unref(); // Allow the parent script to exit independently

  console.log(`✓ Spawned agent '${config.agent}' in background (PID: ${child.pid})`);
  console.log(`✓ Logging output to ${logFile}`);

  const agentsFile = path.resolve(config.coordDir, "agents.json");
  const agents: any = fs.existsSync(agentsFile)
    ? JSON.parse(fs.readFileSync(agentsFile, "utf-8"))
    : {};

  const existing = agents[config.agent];
  agents[config.agent] = {
    task: existing?.task ?? "Initial prompt",
    status: "running",
    worktree,
    cli: config.cli,
    kilo_mode: config.mode,
    pid: child.pid,
    started_at: existing?.started_at ?? new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    validate_cmd: config.validateCmd,
    timeout_mins: config.timeoutMins,
    progress_timeout_mins: config.progressTimeoutMins,
    max_iterations: config.maxIterations,
    restart_count: existing?.restart_count ?? 0,
  };

  fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2) + "\n");
  console.log(`✓ Registered agent in ${agentsFile}`);
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
    validateCmd: undefined,
    timeoutMins: undefined,
    progressTimeoutMins: undefined,
    maxIterations: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      config.extraArgs.push(...args.slice(i + 1));
      break;
    }
    switch (args[i]) {
      case "--agent": config.agent = args[++i]; break;
      case "--mode": config.mode = args[++i]; break;
      case "--prompt-file": config.promptFile = args[++i]; break;
      case "--coord": config.coordDir = args[++i]; break;
      case "--cli": config.cli = args[++i]; break;
      case "--validate": config.validateCmd = parseValidateArg(args[++i]); break;
      case "--timeout": config.timeoutMins = parseInt(args[++i], 10); break;
      case "--progress-timeout": config.progressTimeoutMins = parseInt(args[++i], 10); break;
      case "--max-iterations": config.maxIterations = parseInt(args[++i], 10); break;
    }
  }

  if (!config.agent || !config.promptFile) {
    console.error("Error: --agent and --prompt-file are required");
    process.exit(1);
  }
  return config;

  // Accepts either a JSON array of argv strings (preferred — no shell expansion) or a raw shell
  // command string (legacy). The argv form lets the loop run validation with shell:false.
  function parseValidateArg(raw: string): string | string[] {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
      } catch {}
    }
    return raw;
  }
}

// Shared — used only by spawnAgent above when no CLI template is configured.
function builtinCli(cli: string, prompt: string, promptFile: string, mode: string, extra: string[]) {
  let cmd = "kilo";
  let cmdArgs = [prompt, "--mode", mode, "--auto"];
  if (cli === "aider")     { cmd = "aider";     cmdArgs = ["--message-file", promptFile, "--yes"]; }
  else if (cli === "claude")   { cmd = "claude";    cmdArgs = ["-p", prompt, "--dangerously-skip-permissions"]; }
  else if (cli === "codex")    { cmd = "codex";     cmdArgs = ["--exec", prompt]; }
  else if (cli === "gemini")   { cmd = "gemini";    cmdArgs = ["--prompt", prompt, "--yolo"]; }
  else if (cli === "opencode") { cmd = "opencode";  cmdArgs = ["run", prompt, "--yes"]; }
  if (extra.length > 0) cmdArgs.push(...extra);
  return { cmd, cmdArgs };
}
