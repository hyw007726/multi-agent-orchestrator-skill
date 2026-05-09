#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { loadConfig } = require('./lib/config');
const { safeKill } = require('./lib/process');
const { renderWorkerPrompt } = require('./lib/prompt-render');
const { formatModelHeadsUp } = require('./lib/model-headsup');

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

  const tasks = context.tasks;
  if (!tasks || Object.keys(tasks).length === 0) {
    console.error('Error: No tasks found in context.json.');
    process.exit(1);
  }
  validateExecutionTopology(context, tasks);

  const requestsDir = path.join(args.coordDir, 'requests');
  if (!fs.existsSync(requestsDir)) {
    fs.mkdirSync(requestsDir, { recursive: true });
    console.log(`Created staging directory: ${requestsDir}`);
  }

  const config = loadConfig();
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

    if (fs.existsSync(path.join(projectRoot, worktreePath))) {
      console.error(`Error: Worktree ${worktreePath} already exists for agent ${agentName}.`);
      process.exit(1);
    }

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
    if (pid !== '?') spawnedPids.push({ pid: parseInt(pid, 10), cli, name: agentName });
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

function validateExecutionTopology(context, tasks) {
  const topology = context.execution_topology;
  if (!topology || typeof topology.execution_mode !== 'string' || topology.execution_mode.trim() === '') {
    console.error('Error: context.json execution_topology.execution_mode is required before launching workers. Expected single_worker, parallel, or phased; use direct only when handling the task in the caller session.');
    process.exit(1);
  }

  const mode = topology.execution_mode.trim();
  const taskCount = Object.keys(tasks || {}).length;
  const launchableModes = new Set(['single_worker', 'parallel', 'phased']);
  if (mode === 'direct') {
    console.error('Error: context.json execution_topology.execution_mode is "direct"; handle this task in the caller session instead of launching workers.');
    process.exit(1);
  }
  if (!launchableModes.has(mode)) {
    console.error(`Error: Invalid execution_topology.execution_mode "${mode}". Expected direct, single_worker, parallel, or phased.`);
    process.exit(1);
  }
  if (mode === 'single_worker' && taskCount !== 1) {
    console.error(`Error: execution_mode "single_worker" requires exactly one task, but context.json has ${taskCount}.`);
    process.exit(1);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { coordDir: './coord' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coord') config.coordDir = args[++i];
  }
  return config;
}

// Kills all spawned agents and removes created worktrees + branches.
// Called on partial spawn failure so the repo is left clean.
function rollback(spawnedPids, createdWorktrees, projectRoot) {
  console.error('\nRolling back partial launch...');
  for (const { pid, cli, name } of spawnedPids) {
    safeKill({ pid, expectedCli: cli || 'kilo', log: (msg) => console.error(`  [${name}] ${msg}`) });
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
