#!/usr/bin/env node

/**
 * Spawns a worker CLI agent in the background and registers it in coord/agents.json.
 */

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { updateJSON } = require("./lib/locking");
const { appendEvent } = require("./lib/events");
const { cliTemplateProcessMatch, spawnCliTemplate } = require("./lib/cli-template");

spawnAgent();

function spawnAgent() {
  const config = parseArgs();
  const parsedConfig = loadConfig();
  // Resolve --cli: explicit flag wins, otherwise fall back to `default_cli` from orchestrator config.
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

  // validate-context.js requires non-empty allowed_paths for context.json, but an
  // in-flight edit can still produce a rendered prompt where prompt-render.js
  // substituted "(unspecified)". Spawning a worker with no path scope is unsafe
  // (it has no boundary to respect), so hard-fail here for initial and restart
  // prompts alike.
  if (/ALLOWED PATHS\*{0,2}:?\*{0,2}\s*\(unspecified\)/.test(prompt)) {
    console.error(
      `Error: rendered prompt for agent '${config.agent}' has ALLOWED PATHS: (unspecified).\n` +
      `Refusing to spawn a worker with no path scope. Set a non-empty allowed_paths for ` +
      `'${config.agent}' in context.json and re-run.`,
    );
    process.exit(1);
  }

  const logsDir = path.resolve(config.coordDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${config.agent}.log`);
  const out = fs.openSync(logFile, "a");
  const err = out;

  const cliTemplate = parsedConfig.cli_templates[config.cli];
  const processMatch = cliTemplateProcessMatch(config.cli, cliTemplate);

  let child;
  let templateMode = "unknown";
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
    console.error(`Error: No cli_templates.${config.cli} configured. Add a shell string or { cmd, args } template in orchestrator.config.jsonc.`);
    process.exit(1);
  }

  // detached:true gives the worker its own POSIX process group with child.pid
  // as the group id. The loop's safeKill helper signals that group so wrapper
  // shells and child CLIs are stopped together.
  child.unref();
  const spawnedAt = new Date().toISOString();
  writeSpawnMarker(out, {
    agent: config.agent,
    pid: child.pid,
    cli: config.cli,
    templateMode,
    spawnedAt,
  });

  console.log(`Spawned agent '${config.agent}' in background (PID: ${child.pid})`);
  console.log(`Template mode: ${templateMode}`);
  console.log(`Logging output to ${logFile}`);
  // Machine-readable result line. launch-all.js parses this single JSON object
  // rather than regex-scraping the human-readable lines above, so wording
  // changes can't silently break PID capture (which gates rollback).
  console.log(`__SPAWN_RESULT__ ${JSON.stringify({ pid: child.pid, logFile, templateMode })}`);

  const agentsFile = path.resolve(config.coordDir, "agents.json");
  if (!fs.existsSync(agentsFile)) fs.writeFileSync(agentsFile, "{}\n");

  updateJSON(agentsFile, (agents) => {
    const existing = agents[config.agent] && typeof agents[config.agent] === "object"
      ? agents[config.agent]
      : {};
    const next = {
      ...existing,
      task: taskDescriptionForRecord(config.taskDescription, existing.task),
      status: "running",
      worktree,
      cli: config.cli,
      process_match: processMatch,
      template_mode: templateMode,
      kilo_mode: config.mode,
      pid: child.pid,
      started_at: existing.started_at ?? spawnedAt,
      current_started_at: spawnedAt,
      last_spawned_at: spawnedAt,
      last_heartbeat: spawnedAt,
      validate_cmd: firstDefined(config.validateCmd, existing.validate_cmd),
      validation_timeout_mins: firstDefined(config.validationTimeoutMins, existing.validation_timeout_mins),
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
    data: { cli: config.cli, mode: config.mode, process_match: processMatch, template_mode: templateMode, worktree, current_started_at: spawnedAt },
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
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function taskDescriptionForRecord(taskDescription, existingTask) {
  if (typeof taskDescription === "string" && taskDescription.trim() !== "") {
    return taskDescription;
  }
  return existingTask ?? "Initial prompt";
}

function writeSpawnMarker(fd, { agent, pid, cli, templateMode, spawnedAt }) {
  const line = `[${spawnedAt}] Spawned agent '${agent}' (PID: ${pid}, CLI: ${cli}, template: ${templateMode})\n`;
  fs.writeSync(fd, line);
  const now = new Date(spawnedAt);
  try {
    fs.futimesSync(fd, now, now);
  } catch {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    agent: "",
    mode: "auto",
    promptFile: "",
    coordDir: "./coord",
    cli: "", // resolved against `default_cli` from orchestrator config in spawnAgent if --cli is omitted.
    extraArgs: [],
    validateCmd: undefined,
    validationTimeoutMins: undefined,
    timeoutMins: undefined,
    progressTimeoutMins: undefined,
    baseRef: undefined,
    taskDescription: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      // Power-user passthrough: every argument after a literal `--` is appended
      // verbatim to the resolved CLI template's argv (see spawnCliTemplate's
      // extraArgs). Intended for ad-hoc, manually-invoked spawns that need an
      // extra CLI flag without editing cli_templates. Neither launch-all.js nor
      // the orchestrator loop's respawn path passes `--`, so it is inert during
      // a normal run. It is NOT sanitized — only pass trusted args.
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
      case "--validation-timeout": config.validationTimeoutMins = parseFloat(args[++i]); break;
      case "--timeout":          config.timeoutMins        = parseInt(args[++i], 10); break;
      case "--progress-timeout": config.progressTimeoutMins = parseInt(args[++i], 10); break;
      case "--base-ref":         config.baseRef              = args[++i]; break;
      case "--task-description": config.taskDescription      = args[++i]; break;
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
