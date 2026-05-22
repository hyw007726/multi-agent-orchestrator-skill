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
const { rotateLogIfTooLarge } = require("./lib/log-tail");
const { getProcessCommand } = require("./lib/process");

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
  // so it isn't materialized inside any worktree. Without an exposed coord/, every hardcoded
  // `coord/...` path in the worker prompt and request-staging protocol would resolve to
  // ENOENT and the worker would fail its first read. We expose a per-worker view that
  // contains ONLY the surfaces a worker is meant to touch — see ensureCoordWorkerView.
  ensureCoordWorkerView(worktree, config.coordDir, config.agent);

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

  // Resolve to an absolute path before handing it to the worker. The worker
  // runs with cwd=worktree, so a relative prompt path would resolve through the
  // worker's coord/ symlink — but the per-worker view does NOT expose prompts/,
  // so relative paths like "coord/prompts/restart-<agent>-X.txt" would hit
  // ENOENT. Absolute paths sidestep the view entirely.
  const runtimePromptFile = path.resolve(materializeLaunchPrompt(config, prompt));

  const logsDir = path.resolve(config.coordDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${config.agent}.log`);
  // Rotate before opening the new fd: a running worker holds the log fd open
  // in append mode, so an in-flight rename would silently redirect its writes
  // to the rotated path. Doing it here, between processes, keeps the fresh fd
  // bound to a fresh file. 0 disables rotation.
  rotateLogIfTooLarge(logFile, parsedConfig.worker_log_max_bytes);
  const out = fs.openSync(logFile, "a");
  const err = out;

  const cliTemplate = parsedConfig.cli_templates[config.cli];
  const processMatch = cliTemplateProcessMatch(config.cli, cliTemplate);

  let child;
  let templateMode = "unknown";
  if (cliTemplate) {
    try {
      child = spawnCliTemplate(config.cli, cliTemplate, {
        promptFile: runtimePromptFile,
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
  const agentsFile = path.resolve(config.coordDir, "agents.json");
  if (!fs.existsSync(agentsFile)) fs.writeFileSync(agentsFile, "{}\n");

  try {
    updateJSON(agentsFile, (agents) => {
      const existing = agents[config.agent] && typeof agents[config.agent] === "object"
        ? agents[config.agent]
        : {};
      agents[config.agent] = buildAgentRecord(existing, {
        config,
        status: "spawning",
        worktree,
        processMatch,
        templateMode,
        pid: child.pid,
        spawnedAt,
      });
    });
  } catch (err) {
    killSpawnedChild(child);
    console.error(`Error: spawned worker PID ${child.pid} but could not register it in ${agentsFile}: ${err.message}`);
    process.exit(1);
  }

  if (process.env.SPAWN_AGENT_TEST_EXIT_AFTER_SPAWNING === "1") {
    process.exit(42);
  }

  // Capture the live cmdline. Some CLIs mutate `process.title` later, which
  // breaks the basename substring rule pidMatchesCli falls back to; recording
  // the spawn-time cmdline gives safeKill a stronger reference to compare
  // against. Best-effort — `ps` may race the brand-new child or be absent.
  const spawnedCmdline = getProcessCommand(child.pid) || "";
  writeSpawnMarker(out, {
    agent: config.agent,
    pid: child.pid,
    cli: config.cli,
    templateMode,
    spawnedAt,
  });

  updateJSON(agentsFile, (agents) => {
    const existing = agents[config.agent] && typeof agents[config.agent] === "object"
      ? agents[config.agent]
      : {};
    const next = buildAgentRecord(existing, {
      config,
      status: "running",
      worktree,
      processMatch,
      templateMode,
      pid: child.pid,
      spawnedAt,
      spawnedCmdline,
    });
    delete next.exit_log_tail;
    agents[config.agent] = next;
  });

  appendEvent(config.coordDir, "agent_spawned", {
    agent: config.agent,
    pid: child.pid,
    data: {
      cli: config.cli,
      mode: config.mode,
      process_match: processMatch,
      template_mode: templateMode,
      worktree,
      current_started_at: spawnedAt,
      spawned_cmdline: spawnedCmdline || undefined,
    },
  });

  console.log(`Spawned agent '${config.agent}' in background (PID: ${child.pid})`);
  console.log(`Template mode: ${templateMode}`);
  console.log(`Logging output to ${logFile}`);
  // Machine-readable result line. launch-all.js parses this single JSON object
  // rather than regex-scraping the human-readable lines above, so wording
  // changes can't silently break PID capture (which gates rollback).
  console.log(`__SPAWN_RESULT__ ${JSON.stringify({ pid: child.pid, logFile, templateMode })}`);
  console.log(`Registered agent in ${agentsFile}`);

  // Single-use helper — replaces the previous "symlink the whole coord/ tree into each
  // worktree" shape with a per-worker view that exposes only the surfaces a worker is
  // meant to touch. The worktree's coord symlink points at this restricted view, not
  // at the real coord/.
  //
  // Surfaces exposed in coord-views/<agent>/:
  //   DECISIONS.md         — snapshot copy (writes by the worker stay in the view)
  //   CALLER_CONTEXT.md    — snapshot copy
  //   context.json         — snapshot copy
  //   decisions.json       — symlink to the live recent-decisions snippet (read)
  //   decisions.jsonl      — symlink to the live audit history (read)
  //   requests/            — symlink (write-only ingress; orchestrator validates
  //                          every staged file via consolidateStagedRequests before
  //                          merging into requests.jsonl)
  //   progress/            — symlink (write-only ingress; orchestrator only reads
  //                          the heartbeat file's mtime)
  //
  // What workers CANNOT reach through coord/...:
  //   agents.json, events.jsonl, requests.jsonl, prompts/, logs/, validation/,
  //   orchestrator.log, orchestrator-loop.out, current_run.json, abort.flag,
  //   the singleton lock files.
  //
  // Trust model: macOS lacks portable per-file read-only bind mounts, so we cannot
  // strictly prevent a worker from writing to its own snapshot files or chasing
  // the live decisions symlinks. Defence here is by exposure, not enforcement:
  //   • snapshots protect the orchestrator's source-of-truth durable files
  //     (writes to coord/DECISIONS.md never reach the real DECISIONS.md);
  //   • write paths are validated at the orchestrator boundary;
  //   • dangerous files (agents.json, events.jsonl, prompts/, logs/) are simply
  //     absent from the view, so no documented coord/... path resolves to them.
  //
  // Snapshots are refreshed on every spawn (including respawns / resume), so
  // DECISIONS.md / CALLER_CONTEXT.md / context.json updates between restarts
  // reach the next worker incarnation.
  //
  // Hard-fails on the worktree-side symlink: a worker that boots without coord/
  // discovers every documented coord/... path as ENOENT and the staging protocol
  // silently fails. Surface the underlying errno so the operator can fix FS perms
  // or pre-stage the link manually, rather than letting a broken worker chew
  // through restart budget.
  function ensureCoordWorkerView(worktreeAbs, coordDirArg, agentName) {
    const coordAbs = path.resolve(coordDirArg);
    const viewsRoot = path.resolve(coordAbs, "..", "coord-views");
    const agentView = path.join(viewsRoot, agentName);
    fs.mkdirSync(agentView, { recursive: true });

    refreshSnapshot("DECISIONS.md");
    refreshSnapshot("CALLER_CONTEXT.md");
    refreshSnapshot("context.json");

    refreshSymlink("decisions.json", "file");
    refreshSymlink("decisions.jsonl", "file");

    // requests/ and progress/ must exist before we symlink them. Bootstrap
    // creates them, but a partially-bootstrapped coord/ could be missing one.
    for (const dirName of ["requests", "progress"]) {
      const realDir = path.join(coordAbs, dirName);
      if (!fs.existsSync(realDir)) fs.mkdirSync(realDir, { recursive: true });
    }
    refreshSymlink("requests", "dir");
    refreshSymlink("progress", "dir");

    const coordSymlink = path.join(worktreeAbs, "coord");
    const existing = fs.lstatSync(coordSymlink, { throwIfNoEntry: false });
    if (existing) {
      // Re-point on resume / restart: an old symlink could point at the wrong
      // view (e.g. before this refactor) or be a stale dir.
      try { fs.unlinkSync(coordSymlink); } catch {}
    }
    const target = path.relative(worktreeAbs, agentView);
    try {
      fs.symlinkSync(target, coordSymlink, "dir");
    } catch (err) {
      console.error(`Error: failed to create coord symlink at ${coordSymlink}: ${err.message} (${err.code || "unknown"})`);
      console.error(`Worker cannot run without coord/ — every documented coord/... path would resolve to ENOENT and the staging protocol would silently fail.`);
      console.error(`Fixes (try one):`);
      console.error(`  • Run on a filesystem where the user can create symlinks (some sandboxed FS / SMB shares disallow it).`);
      console.error(`  • Pre-stage the link yourself before re-running:  ln -s ${agentView} ${coordSymlink}`);
      console.error(`  • Bind-mount coord/ at the same path inside the worktree.`);
      process.exit(1);
    }

    // Nested helpers — only used inside ensureCoordWorkerView.
    function refreshSnapshot(name) {
      const src = path.join(coordAbs, name);
      const dest = path.join(agentView, name);
      try { fs.unlinkSync(dest); } catch {}
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      } else {
        fs.writeFileSync(dest, "");
      }
    }
    function refreshSymlink(name, type) {
      const link = path.join(agentView, name);
      try { fs.unlinkSync(link); } catch {}
      const linkTarget = path.relative(agentView, path.join(coordAbs, name));
      fs.symlinkSync(linkTarget, link, type);
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

function buildAgentRecord(existing, { config, status, worktree, processMatch, templateMode, pid, spawnedAt, spawnedCmdline }) {
  const next = {
    ...existing,
    task: taskDescriptionForRecord(config.taskDescription, existing.task),
    status,
    worktree,
    cli: config.cli,
    process_match: processMatch,
    template_mode: templateMode,
    kilo_mode: config.mode,
    pid,
    started_at: existing.started_at ?? spawnedAt,
    current_started_at: spawnedAt,
    last_spawned_at: spawnedAt,
    last_heartbeat: spawnedAt,
    validate_cmd: firstDefined(config.validateCmd, existing.validate_cmd),
    validation: { state: "idle" },
    validation_timeout_mins: firstDefined(config.validationTimeoutMins, existing.validation_timeout_mins),
    timeout_mins: firstDefined(config.timeoutMins, existing.timeout_mins),
    progress_timeout_mins: firstDefined(config.progressTimeoutMins, existing.progress_timeout_mins),
    restart_count: existing.restart_count ?? 0,
    base_ref: firstDefined(config.baseRef, existing.base_ref),
  };
  if (spawnedCmdline !== undefined) {
    next.spawned_cmdline = spawnedCmdline;
  }
  delete next.exit_log_tail;
  return next;
}

function materializeLaunchPrompt(config, prompt) {
  const base = path.basename(config.promptFile || "");
  if (!base.startsWith("launch-all-prompt-") || !base.endsWith(".txt")) {
    return config.promptFile;
  }
  const promptsDir = path.resolve(config.coordDir, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  const promptFile = path.join(promptsDir, `launch-${config.agent}-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, "utf-8");
  sweepLaunchPrompts(promptsDir, config.agent, 10);
  return promptFile;
}

function sweepLaunchPrompts(promptsDir, agentName, keep) {
  const prefix = `launch-${agentName}-`;
  const prompts = [];
  for (const name of fs.readdirSync(promptsDir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".txt")) continue;
    const filePath = path.join(promptsDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) prompts.push({ name, filePath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  prompts.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name));
  for (const stale of prompts.slice(keep)) {
    try { fs.unlinkSync(stale.filePath); } catch {}
  }
}

function killSpawnedChild(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {}
  }
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {}
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
