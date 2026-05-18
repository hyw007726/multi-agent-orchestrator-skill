#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { loadConfig } = require('./lib/config');
const { acquireLock } = require('./lib/locking');
const { safeKill } = require('./lib/process');
const { cliTemplateProcessMatch } = require('./lib/cli-template');
const { renderWorkerPrompt } = require('./lib/prompt-render');
const { formatModelHeadsUp } = require('./lib/model-headsup');
const { validateContext, formatValidationReport } = require('./lib/context-validation');

if (require.main === module) {
  launchAll();
}

function launchAll() {
  const args = parseArgs();
  const projectRoot = process.cwd();

  const contextPath = path.resolve(args.coordDir, 'context.json');
  if (!fs.existsSync(contextPath)) {
    console.error(`Error: ${contextPath} not found. Run bootstrap first.`);
    process.exit(1);
  }

  // Serialize concurrent launches against the same coord/. Without this, two
  // parallel launch-all.js runs would race in spawn-agent.js (each overwrites
  // the other's PID in agents.json) and orphan one worker set with no recorded
  // PID and no supervision.
  const releaseLaunchLock = acquireLaunchLock(args.coordDir);
  process.once('exit', releaseLaunchLock);
  process.once('SIGINT', () => { releaseLaunchLock(); process.exit(130); });
  process.once('SIGTERM', () => { releaseLaunchLock(); process.exit(143); });
  try {
    runLaunch(args, projectRoot, contextPath);
  } finally {
    releaseLaunchLock();
  }
}

function runLaunch(args, projectRoot, contextPath) {
  let context;
  try {
    context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: Failed to parse ${contextPath}: ${err.message}`);
    process.exit(1);
  }

  const config = loadConfig();
  const validation = validateContext(context, config, {
    projectRoot,
    coordDir: args.coordDir,
    requireLaunchable: true,
  });
  const validationText = formatValidationReport(validation, {
    coordDir: args.coordDir,
    contextPath: path.relative(projectRoot, contextPath),
    decisionsPath: path.relative(projectRoot, path.resolve(args.coordDir, 'DECISIONS.md')),
    validateCommand: `node ${path.join(__dirname, 'validate-context.js')} --coord ${args.coordDir}`,
  });
  if (validationText) {
    const stream = validation.errors.length > 0 ? process.stderr : process.stdout;
    stream.write(`${validationText}\n\n`);
  }
  if (validation.errors.length > 0) {
    process.exit(1);
  }

  const tasks = context.tasks;

  const requestsDir = path.join(args.coordDir, 'requests');
  if (!fs.existsSync(requestsDir)) {
    fs.mkdirSync(requestsDir, { recursive: true });
    console.log(`Created staging directory: ${requestsDir}`);
  }

  const projectDescription = context.project || '';

  const templatePath = path.resolve(__dirname, '..', 'references', 'worker-prompt-template.md');
  if (!fs.existsSync(templatePath)) {
    console.error(`Error: Template file not found at ${templatePath}`);
    process.exit(1);
  }
  const template = fs.readFileSync(templatePath, 'utf-8');

  const spawnedAgents = [];
  const spawnedPids = [];
  const createdWorktrees = [];

  const baseBranch = captureBaseBranch(projectRoot, config);
  const workerClis = Array.from(new Set(Object.values(tasks).map((agentRecord) => agentRecord.cli || config.default_cli)));
  console.log(formatModelHeadsUp(config, { workerClis }));
  console.log('');

  // Without this check, `git worktree add -b <agentName>` later in the spawn
  // loop would fail mid-iteration if a branch from a prior aborted run still
  // exists, leaving a half-spawned run plus a partial rollback. Detect those
  // stale branches up front and refuse with actionable cleanup instructions.
  const staleBranches = collectStaleAgentBranches(projectRoot, tasks);
  if (staleBranches.length > 0) {
    const list = staleBranches.map(({ agent, reason }) => `  - ${agent} (${reason})`).join('\n');
    const names = staleBranches.map((entry) => entry.agent).join(' ');
    console.error(
      `Error: Stale agent branches from a prior run are blocking launch:\n${list}\n\n` +
      `Each branch has no matching worktree at the path this launch would use, so ` +
      `'git worktree add -b <agent>' would fail mid-iteration. Clean them up and retry:\n` +
      `  git worktree prune\n` +
      `  git branch -D ${names}\n\n` +
      `If you intended to resume a preserved worktree, ensure the worktree directory ` +
      `still exists and rerun with --resume.`,
    );
    process.exit(1);
  }

  for (const [agentName, agentRecord] of Object.entries(tasks)) {
    const cli = agentRecord.cli || config.default_cli;
    const worktreeBase = cli === 'kilo' ? '.kilocode/worktrees' : '.agents/worktrees';
    const worktreePath = path.join(worktreeBase, agentName);

    const absoluteWorktreePath = path.join(projectRoot, worktreePath);
    if (fs.existsSync(absoluteWorktreePath)) {
      if (!args.resume) {
        console.error(`Error: Worktree ${worktreePath} already exists for agent ${agentName}. Pass --resume to validate and reuse preserved worktrees.`);
        rollbackIfNeeded(spawnedPids, createdWorktrees, projectRoot);
        process.exit(1);
      }

      const resumeCheck = validateExistingWorktree(projectRoot, worktreePath, agentName);
      if (!resumeCheck.ok) {
        console.error(`Error: Cannot resume agent ${agentName} from ${worktreePath}: ${resumeCheck.error}`);
        rollbackIfNeeded(spawnedPids, createdWorktrees, projectRoot);
        process.exit(1);
      }
      console.log(`Resuming existing worktree ${worktreePath} for agent ${agentName}.`);
    } else {
      const addResult = spawnSync('git', ['worktree', 'add', worktreePath, '-b', agentName], {
        cwd: projectRoot,
        encoding: 'utf-8',
      });

      if (addResult.status !== 0) {
        console.error(`Error: Failed to create worktree for ${agentName}:`);
        console.error(addResult.stderr || addResult.stdout);
        rollback(spawnedPids, createdWorktrees, projectRoot);
        process.exit(1);
      }

      createdWorktrees.push({ name: agentName, path: worktreePath });
    }

    const vars = {
      ASSIGNED_TASK: agentRecord.description || '',
      PROJECT_DESCRIPTION: projectDescription,
      AGENT_NAME: agentName,
      WORKTREE_PATH: worktreePath,
      ALLOWED_PATHS_LIST: agentRecord.allowed_paths || [],
      FORBIDDEN_PATHS_LIST: agentRecord.forbidden_paths || [],
      READ_FIRST_LIST: agentRecord.read_first || agentRecord.relevant_files || [],
    };

    const renderedPrompt = renderWorkerPrompt(template, vars);

    const timestamp = Date.now();
    const promptFile = path.join(os.tmpdir(), `launch-all-prompt-${agentName}-${timestamp}.txt`);
    fs.writeFileSync(promptFile, renderedPrompt, 'utf-8');

    const spawnArgs = [
      path.join(__dirname, 'spawn-agent.js'),
      '--agent', agentName,
      '--cli', cli,
      '--prompt-file', promptFile,
      '--coord', args.coordDir,
      '--task-description', agentRecord.description || '',
    ];

    if (agentRecord.mode) {
      spawnArgs.push('--mode', agentRecord.mode);
    }

    if (agentRecord.validation_command !== undefined && agentRecord.validation_command !== null) {
      const validateArg = Array.isArray(agentRecord.validation_command)
        ? JSON.stringify(agentRecord.validation_command)
        : agentRecord.validation_command;
      spawnArgs.push('--validate', validateArg);
    }

    if (agentRecord.timeout_mins !== undefined && agentRecord.timeout_mins !== null) {
      spawnArgs.push('--timeout', String(agentRecord.timeout_mins));
    }

    if (agentRecord.validation_timeout_mins !== undefined && agentRecord.validation_timeout_mins !== null) {
      spawnArgs.push('--validation-timeout', String(agentRecord.validation_timeout_mins));
    }

    if (agentRecord.progress_timeout_mins !== undefined && agentRecord.progress_timeout_mins !== null) {
      spawnArgs.push('--progress-timeout', String(agentRecord.progress_timeout_mins));
    }

    if (baseBranch) {
      spawnArgs.push('--base-ref', baseBranch);
    }

    const spawnResult = spawnSync('node', spawnArgs, {
      cwd: projectRoot,
      encoding: 'utf-8',
    });

    if (spawnResult.status !== 0) {
      console.error(`Error: Failed to spawn agent ${agentName}:`);
      console.error(spawnResult.stderr || spawnResult.stdout);
      recoverOrphanForRollback(spawnedPids, args.coordDir, agentName, cli, config);
      rollback(spawnedPids, createdWorktrees, projectRoot);
      process.exit(1);
    }

    const result = parseSpawnResult(spawnResult.stdout);
    if (!result || !Number.isInteger(result.pid) || result.pid <= 0) {
      console.error(`Error: Could not capture a PID for agent ${agentName} from spawn-agent.js output.`);
      console.error(spawnResult.stdout);
      recoverOrphanForRollback(spawnedPids, args.coordDir, agentName, cli, config);
      rollback(spawnedPids, createdWorktrees, projectRoot);
      process.exit(1);
    }
    const { pid, logFile: logPath = 'coord/logs/', templateMode = 'unknown' } = result;

    spawnedAgents.push({ name: agentName, pid, logPath, templateMode });
    spawnedPids.push({ pid, cli, processMatch: cliTemplateProcessMatch(cli, config.cli_templates[cli]), name: agentName });
    console.log(`Agent '${agentName}' spawned (PID: ${pid}, template: ${templateMode}, log: ${logPath})`);
  }

  const loopOutPath = path.join(args.coordDir, 'orchestrator-loop.out');
  // Append rather than overwrite: when the loop dies before opening its own log
  // (config error, missing PATH entry) the previous run's startup diagnostics
  // are the only trace. Snapshot per-run copies under loop-runs/ and keep the
  // last N so the appended file can't grow unbounded.
  retainLoopOutSnapshot(args.coordDir, loopOutPath);
  const cmd = `nohup node ${JSON.stringify(path.join(__dirname, 'orchestrator-loop.js'))} --coord ${JSON.stringify(args.coordDir)} >> ${JSON.stringify(loopOutPath)} 2>&1 &`;
  const loop = spawn(cmd, [], {
    cwd: projectRoot,
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  loop.unref();

  console.log(`Orchestrator loop backgrounded (PID: ${loop.pid})`);
  console.log(`Dashboard: node ${path.join(__dirname, 'dashboard.js')} --coord ${args.coordDir}`);

  // Single-use helper — only called from the spawn loop above.
  // If spawn-agent.js panicked between its agents.json write and the
  // __SPAWN_RESULT__ print line (e.g. EAGAIN on console.log, signal between
  // statements), the worker CLI is already running with a detached PID but
  // launch-all never received it. lookupOrphanedAgentRecord reads the PID
  // back from agents.json — push it onto spawnedPids here so rollback can
  // kill the orphan instead of leaving it running.
  function recoverOrphanForRollback(spawnedPids, coordDir, agentName, fallbackCli, parsedConfig) {
    const orphan = lookupOrphanedAgentRecord(coordDir, agentName, fallbackCli, parsedConfig);
    if (!orphan) return;
    if (orphan.error) {
      console.error(`Warning: could not read agents.json to look for an orphaned ${agentName} PID: ${orphan.error}`);
      return;
    }
    if (spawnedPids.some((entry) => entry.pid === orphan.pid)) return;
    console.error(`Recovered orphaned PID ${orphan.pid} for ${agentName} from agents.json; queuing it for rollback.`);
    spawnedPids.push({ ...orphan, name: agentName });
  }

  // Single-use helper — only called from launchAll above.
  // Copies the prior run's orchestrator-loop.out into loop-runs/<timestamp>.out
  // before this run appends to it, and prunes to the most recent KEEP snapshots.
  function retainLoopOutSnapshot(coordDir, outPath) {
    const KEEP = 10;
    try {
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return;
      const runsDir = path.join(coordDir, 'loop-runs');
      fs.mkdirSync(runsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(outPath, path.join(runsDir, `${stamp}.out`));
      const snapshots = fs.readdirSync(runsDir).filter((f) => f.endsWith('.out')).sort();
      for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - KEEP))) {
        try { fs.unlinkSync(path.join(runsDir, stale)); } catch {}
      }
    } catch (err) {
      console.error(`Warning: could not snapshot previous orchestrator-loop.out: ${err.message}`);
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { coordDir: './coord', resume: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coord') config.coordDir = args[++i];
    else if (args[i] === '--resume' || args[i] === '--force-existing-worktrees') config.resume = true;
  }
  return config;
}

// Acquires an advisory mutex on the coord/ directory so two concurrent
// launch-all.js invocations cannot race in spawn-agent.js. Auto-recovers if a
// prior launch was SIGKILL'd before releasing (stale window + dead-PID check
// live in acquireLock). Returns a release function that is safe to call twice.
function acquireLaunchLock(coordDir) {
  fs.mkdirSync(coordDir, { recursive: true });
  const marker = path.join(coordDir, 'launch');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
  let release;
  try {
    release = acquireLock(marker, { retries: 0, stale: 600_000 });
  } catch (err) {
    if (err && err.code === 'ELOCKED') {
      console.error(
        `Another launch-all is already running for '${coordDir}'.\n` +
        `Refusing to start a second launch — concurrent launches would race in ` +
        `spawn-agent.js and orphan one worker set (the second writer's PID ` +
        `overwrites the first in agents.json).\n\n` +
        `If you're certain no other launch is running (e.g. it crashed without ` +
        `cleanup), remove the stale marker:  rm -rf '${marker}.lock'`,
      );
      process.exit(1);
    }
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { release(); } catch {}
  };
}

// Returns the subset of agent names whose branch already exists locally but is
// NOT registered to the worktree path this launch would use. Those are the ones
// that would crash `git worktree add -b <agentName>` mid-iteration.
function collectStaleAgentBranches(projectRoot, tasks) {
  const config = loadConfig();
  const worktrees = listGitWorktrees(projectRoot);
  if (worktrees.error) {
    console.error(`Warning: stale-branch pre-check skipped: ${worktrees.error}`);
    return [];
  }
  const branchToWorktree = new Map();
  for (const record of worktrees.records) {
    if (!record.branch) continue;
    branchToWorktree.set(record.branch, normalizeExistingPath(record.worktree));
  }

  const stale = [];
  for (const [agentName, agentRecord] of Object.entries(tasks)) {
    const cli = agentRecord.cli || config.default_cli;
    const worktreeBase = cli === 'kilo' ? '.kilocode/worktrees' : '.agents/worktrees';
    const expectedAbs = normalizeExistingPath(path.join(projectRoot, worktreeBase, agentName));
    const branchRef = `refs/heads/${agentName}`;

    if (!branchExists(projectRoot, agentName)) continue;

    const registeredAt = branchToWorktree.get(branchRef);
    if (!registeredAt) {
      stale.push({ agent: agentName, reason: 'branch exists with no checked-out worktree' });
      continue;
    }
    if (registeredAt !== expectedAbs) {
      stale.push({
        agent: agentName,
        reason: `branch checked out at ${registeredAt}, but this launch expects ${expectedAbs}`,
      });
    }
  }
  return stale;
}

function branchExists(projectRoot, agentName) {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${agentName}`], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function validateExistingWorktree(projectRoot, worktreePath, agentName) {
  const absoluteWorktreePath = path.resolve(projectRoot, worktreePath);
  let stat;
  try {
    stat = fs.statSync(absoluteWorktreePath);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: 'path exists but is not a directory' };
  }

  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: absoluteWorktreePath,
    encoding: 'utf-8',
  });
  if (topLevel.status !== 0) {
    return { ok: false, error: `path is not a usable git worktree (${(topLevel.stderr || topLevel.stdout || '').trim()})` };
  }
  const normalizedTopLevel = normalizeExistingPath(topLevel.stdout.trim());
  const normalizedExpected = normalizeExistingPath(absoluteWorktreePath);
  if (normalizedTopLevel !== normalizedExpected) {
    return { ok: false, error: `git top-level is ${topLevel.stdout.trim()}, expected ${absoluteWorktreePath}` };
  }

  const worktrees = listGitWorktrees(projectRoot);
  if (worktrees.error) {
    return { ok: false, error: worktrees.error };
  }
  const record = worktrees.records.find((entry) => normalizeExistingPath(entry.worktree) === normalizedExpected);
  if (!record) {
    return { ok: false, error: 'path exists but is not registered by git worktree list' };
  }

  const expectedBranch = `refs/heads/${agentName}`;
  if (record.branch !== expectedBranch) {
    return { ok: false, error: `registered worktree is on ${record.branch || 'a detached HEAD'}, expected ${expectedBranch}` };
  }

  return { ok: true };
}

function listGitWorktrees(projectRoot) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return { records: [], error: `failed to inspect git worktrees: ${(result.stderr || result.stdout || '').trim()}` };
  }

  const records = [];
  let current = null;
  for (const field of result.stdout.split('\0')) {
    if (field === '') continue;
    if (field.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { worktree: field.slice('worktree '.length), branch: '' };
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length);
    }
  }
  if (current) records.push(current);
  return { records, error: null };
}

function normalizeExistingPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

// Kills all spawned agents and removes created worktrees + branches.
// Called on partial spawn failure so the repo is left clean.
function rollbackIfNeeded(spawnedPids, createdWorktrees, projectRoot) {
  if (spawnedPids.length === 0 && createdWorktrees.length === 0) return;
  rollback(spawnedPids, createdWorktrees, projectRoot);
}

function rollback(spawnedPids, createdWorktrees, projectRoot) {
  console.error('\nRolling back partial launch...');
  for (const { pid, cli, processMatch, name, recordedCmdline } of spawnedPids) {
    safeKill({
      pid,
      expectedCli: processMatch || cli || 'kilo',
      recordedCmdline,
      log: (msg) => console.error(`  [${name}] ${msg}`),
    });
  }
  for (const { name, path: wtPath } of createdWorktrees) {
    try {
      spawnSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: projectRoot, encoding: 'utf-8' });
      console.error(`  Removed worktree: ${wtPath}`);
    } catch {}
    try {
      spawnSync('git', ['branch', '-D', name], { cwd: projectRoot, encoding: 'utf-8' });
    } catch {}
  }
  console.error('Rollback complete.');
}

// Shared — used by recoverOrphanForRollback (inside runLaunch) and the
// launch-all test suite. Reads agents.json and returns the orphan kill
// descriptor for `agentName` (pid, cli, processMatch, recordedCmdline) if
// spawn-agent.js wrote a valid PID before crashing. Returns null when no
// record exists or the PID is missing/invalid, and `{ error: string }` when
// agents.json itself is unreadable so the caller can surface a warning.
function lookupOrphanedAgentRecord(coordDir, agentName, fallbackCli, parsedConfig) {
  let agentsRecord;
  try {
    const agentsPath = path.resolve(coordDir, 'agents.json');
    if (!fs.existsSync(agentsPath)) return null;
    const agents = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
    agentsRecord = agents && agents[agentName];
  } catch (err) {
    return { error: err.message };
  }
  if (!agentsRecord) return null;
  const pid = Number(agentsRecord.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cli = agentsRecord.cli || fallbackCli;
  const cliTemplate = parsedConfig && parsedConfig.cli_templates ? parsedConfig.cli_templates[cli] : undefined;
  const processMatch = agentsRecord.process_match || cliTemplateProcessMatch(cli, cliTemplate);
  return { pid, cli, processMatch, recordedCmdline: agentsRecord.spawned_cmdline };
}

// Shared — used by launchAll (PID capture from spawn-agent.js) and the
// launch-all test suite. Parses spawn-agent.js's machine-readable
// __SPAWN_RESULT__ line; returns the parsed { pid, logFile, templateMode }
// object, or null if the marker is absent or its payload is unparseable.
function parseSpawnResult(stdout) {
  const marker = '__SPAWN_RESULT__';
  for (const line of String(stdout || '').split('\n')) {
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    try {
      return JSON.parse(line.slice(idx + marker.length).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function captureBaseBranch(projectRoot, config) {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout?.trim()) {
      return result.stdout.trim();
    }
  } catch {}
  return 'main';
}

module.exports = { parseSpawnResult, lookupOrphanedAgentRecord };
