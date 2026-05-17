#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { loadConfig } = require('./lib/config');
const { safeKill } = require('./lib/process');
const { cliTemplateProcessMatch } = require('./lib/cli-template');
const { renderWorkerPrompt } = require('./lib/prompt-render');
const { formatModelHeadsUp } = require('./lib/model-headsup');
const { validateContext, formatValidationReport } = require('./lib/context-validation');

launchAll();

function launchAll() {
  const args = parseArgs();
  const projectRoot = process.cwd();

  const contextPath = path.resolve(args.coordDir, 'context.json');
  if (!fs.existsSync(contextPath)) {
    console.error(`Error: ${contextPath} not found. Run bootstrap first.`);
    process.exit(1);
  }

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
      rollback(spawnedPids, createdWorktrees, projectRoot);
      process.exit(1);
    }

    const pidMatch = spawnResult.stdout.match(/PID:\s*(\d+)/);
    const pid = pidMatch ? pidMatch[1] : '?';
    const logMatch = spawnResult.stdout.match(/Logging output to\s+(.+)/);
    const logPath = logMatch ? logMatch[1] : 'coord/logs/';
    const modeMatch = spawnResult.stdout.match(/Template mode:\s*(\w+)/);
    const templateMode = modeMatch ? modeMatch[1] : 'unknown';

    spawnedAgents.push({ name: agentName, pid, logPath, templateMode });
    if (pid !== '?') spawnedPids.push({ pid: parseInt(pid, 10), cli, processMatch: cliTemplateProcessMatch(cli, config.cli_templates[cli]), name: agentName });
    console.log(`Agent '${agentName}' spawned (PID: ${pid}, template: ${templateMode}, log: ${logPath})`);
  }

  const loopOutPath = path.join(args.coordDir, 'orchestrator-loop.out');
  const cmd = `nohup node ${JSON.stringify(path.join(__dirname, 'orchestrator-loop.js'))} --coord ${JSON.stringify(args.coordDir)} > ${JSON.stringify(loopOutPath)} 2>&1 &`;
  const loop = spawn(cmd, [], {
    cwd: projectRoot,
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  loop.unref();

  console.log(`Orchestrator loop backgrounded (PID: ${loop.pid})`);
  console.log(`Dashboard: node ${path.join(__dirname, 'dashboard.js')} --coord ${args.coordDir}`);
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
  for (const { pid, cli, processMatch, name } of spawnedPids) {
    safeKill({ pid, expectedCli: processMatch || cli || 'kilo', log: (msg) => console.error(`  [${name}] ${msg}`) });
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
