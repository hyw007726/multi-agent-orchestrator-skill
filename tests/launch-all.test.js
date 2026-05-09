'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  runLoop,
  waitFor,
  readJson,
  readJsonl,
  cleanupProcess,
} = require('./helpers/temp-project');

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
      context.tasks = {
        'agent-alpha': {
          description: 'Fake worker alpha task — produce alpha output',
          cli: 'fake',
          allowed_paths: ['alpha/**', 'tests/**'],
          forbidden_paths: ['beta/**', 'gamma/**'],
          validation_command: null,
        },
        'agent-beta': {
          description: 'Fake worker beta task — produce beta output',
          cli: 'fake',
          allowed_paths: ['beta/**', 'tests/**'],
          forbidden_paths: ['alpha/**', 'gamma/**'],
          validation_command: null,
        },
        'agent-gamma': {
          description: 'Fake worker gamma task — produce gamma output',
          cli: 'fake',
          allowed_paths: ['gamma/**', 'tests/**'],
          forbidden_paths: ['alpha/**', 'beta/**'],
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
      }
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
});

function runLaunchAll(scriptPath, cwd) {
  const result = runLaunchAllRaw(scriptPath, cwd);
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

function runLaunchAllRaw(scriptPath, cwd) {
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', [scriptPath, '--coord', './coord'], {
    encoding: 'utf-8',
    cwd,
  });
  return result;
}
