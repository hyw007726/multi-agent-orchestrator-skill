#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { loadConfig } = require('./lib/config');
const { renderWorkerPrompt } = require('./lib/prompt-render');

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

  const config = loadConfig();
  const projectDescription = context.project || '';

  const templatePath = path.resolve(__dirname, '..', 'references', 'worker-prompt-template.md');
  if (!fs.existsSync(templatePath)) {
    console.error(`Error: Template file not found at ${templatePath}`);
    process.exit(1);
  }
  const template = fs.readFileSync(templatePath, 'utf-8');

  const spawnedAgents = [];

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
      process.exit(1);
    }

    const vars = {
      ASSIGNED_TASK: agentRecord.description || '',
      PROJECT_DESCRIPTION: projectDescription,
      AGENT_NAME: agentName,
      WORKTREE_PATH: worktreePath,
      ALLOWED_PATHS_LIST: agentRecord.allowed_paths || [],
      FORBIDDEN_PATHS_LIST: agentRecord.forbidden_paths || [],
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

    const spawnResult = spawnSync('node', spawnArgs, {
      cwd: projectRoot,
      encoding: 'utf-8',
    });

    if (spawnResult.status !== 0) {
      console.error(`Error: Failed to spawn agent ${agentName}:`);
      console.error(spawnResult.stderr || spawnResult.stdout);
      console.error('Already-spawned agents are still alive; check their logs in coord/logs/.');
      process.exit(1);
    }

    const pidMatch = spawnResult.stdout.match(/PID:\s*(\d+)/);
    const pid = pidMatch ? pidMatch[1] : '?';
    const logMatch = spawnResult.stdout.match(/Logging output to\s+(.+)/);
    const logPath = logMatch ? logMatch[1] : 'coord/logs/';

    spawnedAgents.push({ name: agentName, pid, logPath });
    console.log(`Agent '${agentName}' spawned (PID: ${pid}, log: ${logPath})`);
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
  const config = { coordDir: './coord' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coord') config.coordDir = args[++i];
  }
  return config;
}
