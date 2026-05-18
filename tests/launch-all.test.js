'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  addKiloWorktree,
  runLoop,
  waitFor,
  readJson,
  readJsonl,
  cleanupProcess,
} = require('./helpers/temp-project');

const { parseSpawnResult } = require(path.join(repoRoot(), 'scripts', 'launch-all.js'));

const fakeCliPath = path.join(repoRoot(), 'tests/helpers/fake-cli.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('launch-all smoke test', () => {
  it('launches multiple fake workers and the orchestrator loop drives them to completion', async () => {
    let project;
    try {
      project = createTempProject('launch-all-');

      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Launch-all smoke test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Fake workers own separate paths.',
        dependency_notes: [],
      };
      context.foundation = { status: 'not_required', paths: [] };
      context.tasks = {
        'agent-alpha': {
          description: 'Fake worker alpha task — produce alpha output',
          cli: 'fake',
          allowed_paths: ['alpha/**', 'tests/**', 'worker-output.txt'],
          forbidden_paths: ['beta/**', 'gamma/**', '.gitignore', 'orchestrator.config.js', 'coord/'],
          validation_command: null,
        },
        'agent-beta': {
          description: 'Fake worker beta task — produce beta output',
          cli: 'fake',
          allowed_paths: ['beta/**', 'tests/**', 'worker-output.txt'],
          forbidden_paths: ['alpha/**', 'gamma/**', '.gitignore', 'orchestrator.config.js', 'coord/'],
          validation_command: null,
        },
        'agent-gamma': {
          description: 'Fake worker gamma task — produce gamma output',
          cli: 'fake',
          allowed_paths: ['gamma/**', 'tests/**', 'worker-output.txt'],
          forbidden_paths: ['alpha/**', 'beta/**', '.gitignore', 'orchestrator.config.js', 'coord/'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

      const launchScript = path.join(repoRoot(), 'scripts', 'launch-all.js');
      const launchResult = runLaunchAll(launchScript, project.root);

      const loopPidMatch = launchResult.stdout.match(/Orchestrator loop backgrounded \(PID:\s*(\d+)\)/);
      const loopPid = loopPidMatch ? parseInt(loopPidMatch[1], 10) : null;

      const agentNames = ['agent-alpha', 'agent-beta', 'agent-gamma'];
      const worktreesDir = path.join(project.root, '.agents', 'worktrees');
      for (const name of agentNames) {
        assert.ok(
          fs.existsSync(path.join(worktreesDir, name)),
          `Worktree for ${name} should exist`
        );
      }

      await waitFor(() => {
        try {
          const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
          return agents && agentNames.every((n) => agents[n] && agents[n].status === 'completed');
        } catch {
          return false;
        }
      }, { timeoutMs: 15000 });

      if (loopPid) {
        cleanupProcess(loopPid);
      }
      const lockPidFile = path.join(project.root, 'coord', 'orchestrator.instance.lock', 'pid');
      if (fs.existsSync(lockPidFile)) {
        try {
          const lockPid = parseInt(fs.readFileSync(lockPidFile, 'utf-8'), 10);
          cleanupProcess(lockPid);
        } catch {}
      }
      const lockDir = path.join(project.root, 'coord', 'orchestrator.instance.lock');
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
      await sleep(500);

      const requestsPath = path.join(project.root, 'coord', 'requests.jsonl');
      const requests = readJsonl(requestsPath);
      const cleaned = requests.map((r) =>
        r.status === 'pending' ? { ...r, status: 'resolved' } : r
      );
      fs.writeFileSync(
        requestsPath,
        cleaned.map((r) => JSON.stringify(r)).join('\n') + (cleaned.length ? '\n' : '')
      );

      const decisionsPath = path.join(project.root, 'coord', 'decisions.json');
      if (fs.existsSync(decisionsPath)) {
        const decisions = readJson(decisionsPath);
        decisions.push({
          request_id: 'agent-one-req-smoke',
          decision: 'Smoke-test completion approved.',
          reason: 'Test harness force-resolved duplicate fake-CLI review requests.',
          resolved_at: new Date().toISOString(),
        });
        fs.writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2) + '\n');
      }

      const loopResult = runLoop(project.root);
      assert.strictEqual(
        loopResult.status,
        0,
        `orchestrator loop failed\nstdout:\n${loopResult.stdout}\nstderr:\n${loopResult.stderr}`
      );

      const summaryPath = path.join(project.root, 'coord', 'review-summary.txt');
      assert.ok(fs.existsSync(summaryPath), 'review-summary.txt should exist');

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(summary.length > 0, 'review-summary.txt should not be empty');

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      for (const name of agentNames) {
        assert.ok(agents[name], `agents.json should contain ${name}`);
        assert.strictEqual(agents[name].status, 'completed');
        assert.strictEqual(agents[name].task, context.tasks[name].description);
      }
      assert.match(summary, /Fake worker alpha task/);
      assert.match(summary, /Fake worker beta task/);
      assert.match(summary, /Fake worker gamma task/);
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('rejects non-launchable or inconsistent execution topologies before spawning workers', () => {
    let project;
    try {
      project = createTempProject('launch-all-topology-');
      bootstrapProject(project.root, 'Launch-all topology guard project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-unneeded': {
          description: 'This should not launch',
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

      const launchScript = path.join(repoRoot(), 'scripts', 'launch-all.js');
      const blankTopologyResult = runLaunchAllRaw(launchScript, project.root);
      assert.notStrictEqual(blankTopologyResult.status, 0);
      assert.match(blankTopologyResult.stderr, /execution_topology\.execution_mode is required/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));

      delete context.execution_topology;
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

      const missingTopologyResult = runLaunchAllRaw(launchScript, project.root);
      assert.notStrictEqual(missingTopologyResult.status, 0);
      assert.match(missingTopologyResult.stderr, /execution_topology\.execution_mode is required/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));

      context.execution_topology = {
        execution_mode: 'direct',
        reason: 'Small sequential task.',
        dependency_notes: [],
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

      const directResult = runLaunchAllRaw(launchScript, project.root);
      assert.notStrictEqual(directResult.status, 0);
      assert.match(directResult.stderr, /execution_topology\.execution_mode is "direct"/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));

      context.execution_topology.execution_mode = 'single_worker';
      context.execution_topology.reason = 'Substantial but sequential.';
      context.tasks['agent-extra'] = {
        description: 'Second worker should be rejected in single_worker mode',
        validation_command: null,
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

      const singleWorkerResult = runLaunchAllRaw(launchScript, project.root);
      assert.notStrictEqual(singleWorkerResult.status, 0);
      assert.match(singleWorkerResult.stderr, /requires exactly one task/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('resumes preserved worktrees after an abort when --resume is explicit', { timeout: 30000 }, async () => {
    let project;
    try {
      project = createTempProject('launch-all-resume-');

      const cliPath = writeResumeCli(project.root);
      writeNodeProjectConfig(project.root, cliPath);
      bootstrapProject(project.root, 'Launch-all resume test project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'single_worker',
        reason: 'One preserved worker can be relaunched safely.',
        dependency_notes: [],
      };
      context.foundation = { status: 'not_required', paths: [] };
      context.tasks = {
        'agent-resume': {
          description: 'Initial resume assignment',
          cli: 'node',
          allowed_paths: ['resume-spawns.jsonl'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const launchScript = path.join(repoRoot(), 'scripts', 'launch-all.js');
      const firstLaunch = runLaunchAll(launchScript, project.root);
      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-resume');
      const runsPath = path.join(worktree, 'resume-spawns.jsonl');

      await waitFor(() => {
        if (!fs.existsSync(runsPath)) return false;
        return readJsonl(runsPath).length === 1;
      }, { timeoutMs: 10000, intervalMs: 100 });

      const firstAgents = readJson(path.join(project.root, 'coord', 'agents.json'));
      const firstPid = firstAgents['agent-resume'].pid;
      assert.strictEqual(firstAgents['agent-resume'].status, 'running');

      const firstLoopPid = parseLoopPid(firstLaunch.stdout);
      fs.writeFileSync(path.join(project.root, 'coord', 'abort.flag'), 'stop\n', 'utf-8');

      await waitFor(() => {
        const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
        return agents['agent-resume'] && agents['agent-resume'].status === 'terminated';
      }, { timeoutMs: 10000, intervalMs: 100 });
      await waitFor(() => !fs.existsSync(path.join(project.root, 'coord', 'orchestrator.instance.lock')), {
        timeoutMs: 10000,
        intervalMs: 100,
      });
      if (firstLoopPid) cleanupProcess(firstLoopPid);

      const updatedContext = readJson(contextPath);
      updatedContext.tasks['agent-resume'].description = 'Refreshed resume assignment';
      fs.writeFileSync(contextPath, JSON.stringify(updatedContext, null, 2) + '\n');

      const refused = runLaunchAllRaw(launchScript, project.root);
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /already exists/);
      assert.match(refused.stderr, /--resume/);

      const resumed = runLaunchAll(launchScript, project.root, ['--resume']);
      assert.match(resumed.stdout, /Resuming existing worktree \.agents\/worktrees\/agent-resume/);

      await waitFor(() => {
        if (!fs.existsSync(runsPath)) return false;
        const runs = readJsonl(runsPath);
        return runs.length >= 2 && runs[runs.length - 1].assignment === 'Refreshed resume assignment';
      }, { timeoutMs: 10000, intervalMs: 100 });

      const resumedAgents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(resumedAgents['agent-resume'].status, 'running');
      assert.notStrictEqual(resumedAgents['agent-resume'].pid, firstPid);
      assert.strictEqual(resumedAgents['agent-resume'].task, 'Refreshed resume assignment');

      const secondLoopPid = parseLoopPid(resumed.stdout);
      fs.writeFileSync(path.join(project.root, 'coord', 'abort.flag'), 'stop\n', 'utf-8');
      await waitFor(() => {
        const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
        return agents['agent-resume'] && agents['agent-resume'].status === 'terminated';
      }, { timeoutMs: 10000, intervalMs: 100 });
      if (secondLoopPid) cleanupProcess(secondLoopPid);
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('rejects resume when an existing worktree is on another branch', () => {
    let project;
    try {
      project = createTempProject('launch-all-resume-branch-');

      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Launch-all resume branch validation project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'single_worker',
        reason: 'Validate preserved worktree branch ownership.',
        dependency_notes: [],
      };
      context.foundation = { status: 'not_required', paths: [] };
      context.tasks = {
        'agent-resume': {
          description: 'This worker must own its matching branch.',
          cli: 'fake',
          allowed_paths: ['resume/**'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      fs.mkdirSync(path.join(project.root, '.agents', 'worktrees'), { recursive: true });
      const addResult = spawnSync('git', [
        'worktree',
        'add',
        path.join('.agents', 'worktrees', 'agent-resume'),
        '-b',
        'agent-other',
      ], {
        cwd: project.root,
        encoding: 'utf-8',
      });
      assert.strictEqual(addResult.status, 0, addResult.stderr || addResult.stdout);

      const launchScript = path.join(repoRoot(), 'scripts', 'launch-all.js');
      const result = runLaunchAllRaw(launchScript, project.root, ['--resume']);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Cannot resume agent agent-resume/);
      assert.match(result.stderr, /expected refs\/heads\/agent-resume/);
      assert.ok(!fs.existsSync(path.join(project.root, 'coord', 'logs', 'agent-resume.log')));
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('refuses to launch when another launch-all is already holding the launch.lock', () => {
    let project;
    try {
      project = createTempProject('launch-all-lock-');

      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Launch-all mutex pre-check project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Fake workers own separate paths.',
        dependency_notes: [],
      };
      context.foundation = { status: 'not_required', paths: [] };
      context.tasks = {
        'agent-alpha': {
          description: 'alpha task',
          cli: 'fake',
          allowed_paths: ['alpha/**'],
          forbidden_paths: ['beta/**', '.gitignore', 'orchestrator.config.js', 'coord/'],
          validation_command: null,
        },
        'agent-beta': {
          description: 'beta task',
          cli: 'fake',
          allowed_paths: ['beta/**'],
          forbidden_paths: ['alpha/**', '.gitignore', 'orchestrator.config.js', 'coord/'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      // Simulate another launch-all holding the lock. acquireLock treats a PID
      // file pointing at a live process as a valid holder; we use this test
      // runner's own PID so the holder check sees an "alive" process.
      const lockMarker = path.join(project.root, 'coord', 'launch');
      fs.writeFileSync(lockMarker, '');
      const lockDir = `${lockMarker}.lock`;
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));

      const launchScript = path.join(repoRoot(), 'scripts', 'launch-all.js');
      const result = runLaunchAllRaw(launchScript, project.root);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Another launch-all is already running/);
      assert.match(result.stderr, /remove the stale marker/);
      // No worktrees were created — refusal happens before any spawn work.
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees', 'agent-alpha')));
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees', 'agent-beta')));
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('refuses to launch when a stale agent branch from a prior aborted run is present', () => {
    let project;
    try {
      project = createTempProject('launch-all-stale-branch-');

      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Launch-all stale-branch pre-check project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Fake workers own separate paths.',
        dependency_notes: [],
      };
      context.foundation = { status: 'not_required', paths: [] };
      context.tasks = {
        'agent-alpha': {
          description: 'alpha task',
          cli: 'fake',
          allowed_paths: ['alpha/**'],
          forbidden_paths: ['beta/**', '.gitignore', 'orchestrator.config.js', 'coord/'],
          validation_command: null,
        },
        'agent-beta': {
          description: 'beta task',
          cli: 'fake',
          allowed_paths: ['beta/**'],
          forbidden_paths: ['alpha/**', '.gitignore', 'orchestrator.config.js', 'coord/'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      // Simulate the post-abort state: branches survive but their worktrees are gone.
      const orphan = spawnSync('git', ['branch', 'agent-alpha'], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(orphan.status, 0, orphan.stderr || orphan.stdout);

      const launchScript = path.join(repoRoot(), 'scripts', 'launch-all.js');
      const result = runLaunchAllRaw(launchScript, project.root);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Stale agent branches/);
      assert.match(result.stderr, /agent-alpha/);
      assert.doesNotMatch(result.stderr, /agent-beta \(/);
      assert.match(result.stderr, /git branch -D agent-alpha/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees', 'agent-alpha')));
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees', 'agent-beta')));
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});

describe('spawn-agent.js __SPAWN_RESULT__ capture', () => {
  it('parseSpawnResult extracts the JSON payload and rejects missing/garbled lines', () => {
    const ok = parseSpawnResult(
      'Spawned agent x (PID: 4242)\n__SPAWN_RESULT__ {"pid":4242,"logFile":"/tmp/x.log","templateMode":"argv"}\n',
    );
    assert.deepStrictEqual(ok, { pid: 4242, logFile: '/tmp/x.log', templateMode: 'argv' });

    // No marker at all → null (launch-all treats this as a spawn failure).
    assert.strictEqual(parseSpawnResult('Spawned agent x (PID: 4242)\n'), null);
    // Marker present but payload is not JSON → null.
    assert.strictEqual(parseSpawnResult('__SPAWN_RESULT__ not-json\n'), null);
    assert.strictEqual(parseSpawnResult(''), null);
  });

  it('spawn-agent.js emits a parseable __SPAWN_RESULT__ line whose pid matches agents.json', () => {
    let project;
    try {
      project = createTempProject('spawn-result-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Spawn result contract project');
      addKiloWorktree(project.root, 'agent-result');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(
        promptFile,
        'ALLOWED PATHS: result/**\nDo the work.',
        'utf-8',
      );

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-result',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'fake',
      ], { cwd: project.root, encoding: 'utf-8' });

      assert.strictEqual(spawnResult.status, 0, spawnResult.stderr);

      const parsed = parseSpawnResult(spawnResult.stdout);
      assert.ok(parsed, 'a __SPAWN_RESULT__ line must be present');
      assert.ok(Number.isInteger(parsed.pid) && parsed.pid > 0, 'pid must be a positive integer');
      assert.ok(typeof parsed.logFile === 'string' && parsed.logFile.length > 0);
      assert.ok(typeof parsed.templateMode === 'string' && parsed.templateMode.length > 0);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-result'].pid, parsed.pid);

      cleanupProcess(parsed.pid);
    } finally {
      if (project) project.cleanup();
    }
  });
});

function runLaunchAll(scriptPath, cwd, extraArgs = []) {
  const result = runLaunchAllRaw(scriptPath, cwd, extraArgs);
  if (result.error) {
    throw new Error(
      `launch-all.js failed: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    const msg = [
      `launch-all.js failed with exit code ${result.status}`,
      `stdout: ${result.stdout || '(empty)'}`,
      `stderr: ${result.stderr || '(empty)'}`,
    ].join('\n');
    throw new Error(msg);
  }
  return result;
}

function runLaunchAllRaw(scriptPath, cwd, extraArgs = []) {
  const result = spawnSync('node', [scriptPath, '--coord', './coord', ...extraArgs], {
    encoding: 'utf-8',
    cwd,
  });
  return result;
}

function parseLoopPid(output) {
  const match = output.match(/Orchestrator loop backgrounded \(PID:\s*(\d+)\)/);
  return match ? parseInt(match[1], 10) : null;
}

function writeResumeCli(projectRoot) {
  const cliPath = path.join(projectRoot, 'resume-cli.js');
  fs.writeFileSync(cliPath, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("fs");',
    'if (process.argv[2] === "--version") { console.log("resume-cli 1.0"); process.exit(0); }',
    'const promptFile = process.argv[2];',
    'const prompt = fs.readFileSync(promptFile, "utf-8");',
    'const assignmentMatch = prompt.match(/Specific assignment: (.*)/);',
    'const assignment = assignmentMatch ? assignmentMatch[1].trim() : "";',
    'const agentMatch = prompt.match(/Agent name: ([^\\n]+)/);',
    'const agent = agentMatch ? agentMatch[1].trim() : "unknown";',
    'fs.appendFileSync("resume-spawns.jsonl", JSON.stringify({',
    '  agent,',
    '  assignment,',
    '  pid: process.pid,',
    '  at: new Date().toISOString(),',
    '}) + "\\n", "utf-8");',
    'const timer = setInterval(() => {}, 1000);',
    'process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });',
    'process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });',
  ].join('\n') + '\n');
  return cliPath;
}

function writeNodeProjectConfig(projectRoot, cliPath) {
  fs.writeFileSync(path.join(projectRoot, 'orchestrator.config.js'), [
    'module.exports = {',
    '  default_cli: "node",',
    '  orchestrator_cli: "node",',
    '  cli_templates: {',
    `    node: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(cliPath)}, { prompt_file: true }] },`,
    '  },',
    '  cli_health_checks: {',
    `    node: ${JSON.stringify(`${shellQuote(process.execPath)} -e "process.exit(0)"`)},`,
    '  },',
    '  poll_min_ms: 250,',
    '  poll_max_ms: 500,',
    '  launch_dashboard: false,',
    '  launch_review_terminal: false,',
    '};',
  ].join('\n') + '\n', 'utf-8');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
