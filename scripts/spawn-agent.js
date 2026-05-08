#!/usr/bin/env node

/**
 * Spawns a worker CLI agent in the background and registers it in coord/agents.json.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { updateJSON } = require("./lib/locking");
const { appendEvent } = require("./lib/events");
const { spawnCliTemplate } = require("./lib/cli-template");

spawnAgent();

function spawnAgent() {
  const config = parseArgs();
  const parsedConfig = loadConfig();
  // Resolve --cli: explicit flag wins, otherwise fall back to `default_cli` from orchestrator.config.js.
  if (!config.cli) config.cli = parsedConfig.default_cli;

  const worktreeBase = config.cli === "kilo" ? ".kilocode/worktrees" : ".agents/worktrees";
  const worktree = path.resolve(process.cwd(), worktreeBase, config.agent);

  if (!fs.existsSync(worktree)) {
    console.error(`Error: Worktree ${worktree} does not exist. Run 'git worktree add ${path.relative(process.cwd(), worktree)} -b ${config.agent}' first.`);
    process.exit(1);
  }

  // Workers run with cwd=worktree, but coord/ lives at the project root and is gitignored,
  // so it isn't materialized inside any worktree. Without this symlink, every hardcoded
  // `coord/...` path in the worker prompt and request-staging protocol would resolve
  // to a missing path and the worker would fail its first read. Use a relative target so
  // the link survives project-directory renames.
  ensureCoordSymlink(worktree, config.coordDir);

  const prompt = fs.readFileSync(config.promptFile, "utf-8");

  const logsDir = path.resolve(config.coordDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${config.agent}.log`);
  const out = fs.openSync(logFile, "a");
  const err = out;

  const cliTemplate = parsedConfig.cli_templates[config.cli];

  let child;
  let templateMode = "builtin";
  if (cliTemplate) {
    try {
      child = spawnCliTemplate(config.cli, cliTemplate, {
        promptFile: config.promptFile,
        promptText: prompt,
        extraArgs: config.extraArgs,
        detached: true,
        stdio: ["ignore", out, err],
        cwd: worktree,
      });
      templateMode = child.templateMode;
    } catch (err) {
      console.error(`Error: invalid cli_templates.${config.cli}: ${err.message}`);
      process.exit(1);
    }
  } else {
    const { cmd, cmdArgs } = builtinCli(config.cli, prompt, config.promptFile, config.mode, config.extraArgs);
    child = spawn(cmd, cmdArgs, {
      detached: true,
      stdio: ["ignore", out, err],
      cwd: worktree,
    });
  }

  // detached:true gives the worker its own POSIX process group with child.pid
  // as the group id. The loop's safeKill helper signals that group so wrapper
  // shells and child CLIs are stopped together.
  child.unref();

  console.log(`Spawned agent '${config.agent}' in background (PID: ${child.pid})`);
  console.log(`Template mode: ${templateMode}`);
  console.log(`Logging output to ${logFile}`);

  const agentsFile = path.resolve(config.coordDir, "agents.json");
  if (!fs.existsSync(agentsFile)) fs.writeFileSync(agentsFile, "{}\n");

  updateJSON(agentsFile, (agents) => {
    const existing = agents[config.agent] && typeof agents[config.agent] === "object"
      ? agents[config.agent]
      : {};
    const next = {
      ...existing,
      task: existing.task ?? "Initial prompt",
      status: "running",
      worktree,
      cli: config.cli,
      template_mode: templateMode,
      kilo_mode: config.mode,
      pid: child.pid,
      started_at: existing.started_at ?? new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      validate_cmd: firstDefined(config.validateCmd, existing.validate_cmd),
      timeout_mins: firstDefined(config.timeoutMins, existing.timeout_mins),
      progress_timeout_mins: firstDefined(config.progressTimeoutMins, existing.progress_timeout_mins),
      restart_count: existing.restart_count ?? 0,
      base_ref: firstDefined(config.baseRef, existing.base_ref),
    };
    delete next.exit_log_tail;
    agents[config.agent] = next;
  });
  console.log(`Registered agent in ${agentsFile}`);

  appendEvent(config.coordDir, "agent_spawned", {
    agent: config.agent,
    pid: child.pid,
    data: { cli: config.cli, mode: config.mode, template_mode: templateMode, worktree },
  });

  // Single-use helper — creates the coord/ symlink inside the worktree so workers can
  // reach the orchestration state via the documented `coord/...` relative paths.
  // Idempotent: skips if a coord symlink (or directory, in case the user pre-staged one)
  // is already present. Failures are warned, not fatal — the worker may still succeed if
  // its prompt was generated with absolute paths.
  function ensureCoordSymlink(worktreeAbs, coordDirArg) {
    const coordSymlink = path.join(worktreeAbs, "coord");
    if (fs.existsSync(coordSymlink) || fs.lstatSync(coordSymlink, { throwIfNoEntry: false })) return;
    const coordAbs = path.resolve(coordDirArg);
    const target = path.relative(worktreeAbs, coordAbs);
    try {
      fs.symlinkSync(target, coordSymlink, "dir");
    } catch (err) {
      console.warn(`Warning: failed to create coord symlink at ${coordSymlink}: ${err.message}`);
      console.warn(`The worker may not find coord/. Create it manually with:`);
      console.warn(`  ln -s ${coordAbs} ${coordSymlink}`);
    }
  }

  // Single-use helper — only used by spawnAgent when no CLI template is configured.
  function builtinCli(cli, prompt, promptFile, mode, extra) {
    let cmd = "kilo";
    let cmdArgs = [prompt, "--mode", mode, "--auto"];
    if (cli === "aider")     { cmd = "aider";     cmdArgs = ["--message-file", promptFile, "--yes"]; }
    else if (cli === "claude")   { cmd = "claude";    cmdArgs = ["-p", prompt, "--dangerously-skip-permissions"]; }
    else if (cli === "codex")    { cmd = "codex";     cmdArgs = ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt]; }
    else if (cli === "gemini")   { cmd = "gemini";    cmdArgs = ["--prompt", prompt, "--yolo"]; }
    else if (cli === "opencode") { cmd = "opencode";  cmdArgs = ["run", prompt, "--yes"]; }
    if (extra.length > 0) cmdArgs.push(...extra);
    return { cmd, cmdArgs };
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    agent: "",
    mode: "auto",
    promptFile: "",
    coordDir: "./coord",
    cli: "", // resolved against `default_cli` from orchestrator.config.js in spawnAgent if --cli is omitted.
    extraArgs: [],
    validateCmd: undefined,
    timeoutMins: undefined,
    progressTimeoutMins: undefined,
    baseRef: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      config.extraArgs.push(...args.slice(i + 1));
      break;
    }
    switch (args[i]) {
      case "--agent":            config.agent              = args[++i]; break;
      case "--mode":             config.mode               = args[++i]; break;
      case "--prompt-file":      config.promptFile         = args[++i]; break;
      case "--coord":            config.coordDir           = args[++i]; break;
      case "--cli":              config.cli                = args[++i]; break;
      case "--validate":         config.validateCmd        = parseValidateArg(args[++i]); break;
      case "--timeout":          config.timeoutMins        = parseInt(args[++i], 10); break;
      case "--progress-timeout": config.progressTimeoutMins = parseInt(args[++i], 10); break;
      case "--base-ref":         config.baseRef              = args[++i]; break;
    }
  }

  if (!config.agent || !config.promptFile) {
    console.error("Error: --agent and --prompt-file are required");
    process.exit(1);
  }
  return config;

  // Accepts either a JSON array of argv strings (preferred — no shell expansion) or a raw shell
  // command string (legacy). The argv form lets the loop run validation with shell:false.
  function parseValidateArg(raw) {
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
