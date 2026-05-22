'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  addKiloWorktree,
} = require('./helpers/temp-project');

describe('spawn-agent.js coord symlink failure', () => {
  let project;
  let worktree;

  before(() => {
    project = createTempProject('spawn-symlink-fail-');

    // Minimal fake CLI — not actually invoked, since the symlink failure
    // exits before spawn. Just needs to exist for the config.
    const cliPath = path.join(project.root, 'fake-cli.js');
    fs.writeFileSync(cliPath, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf-8');
    writeProjectConfig(project.root, cliPath);
    bootstrapProject(project.root, 'Symlink failure test');

    const contextPath = path.join(project.root, 'coord', 'context.json');
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
    context.tasks = {
      'agent-symlink': {
        description: 'Symlink failure test agent.',
        cli: 'fake',
        allowed_paths: ['*.txt'],
      },
    };
    fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

    addKiloWorktree(project.root, 'agent-symlink');
    worktree = path.join(project.root, '.agents', 'worktrees', 'agent-symlink');
  });

  after(() => {
    // Restore writable so the cleanup can rm -rf.
    try { fs.chmodSync(worktree, 0o755); } catch {}
    if (project) project.cleanup();
  });

  it('exits non-zero with a clear message when the worktree denies symlink creation', () => {
    // Force symlinkSync to fail by making the worktree read-only. On macOS and
    // Linux this produces EACCES on symlink(2). On platforms where this trick
    // doesn't reliably block symlinks (some FUSE / mounted volumes), the test
    // would falsely pass — we run our CI on Darwin/Linux ext4 where chmod 555
    // is honored.
    fs.chmodSync(worktree, 0o555);

    // Sanity check: actually verify the chmod blocks symlink creation here, so
    // we don't get a false-positive when the platform ignores read-only dirs.
    let symlinkBlocked = false;
    const probe = path.join(worktree, '.symlink-probe');
    try {
      fs.symlinkSync('/tmp', probe, 'dir');
      try { fs.unlinkSync(probe); } catch {}
    } catch (err) {
      symlinkBlocked = err.code === 'EACCES' || err.code === 'EPERM';
    }
    if (!symlinkBlocked) {
      // Environment doesn't honor read-only-dir → can't exercise the fix.
      return;
    }

    const promptFile = path.join(project.root, 'symlink-prompt.txt');
    fs.writeFileSync(promptFile, 'unused prompt', 'utf-8');

    const result = spawnSync('node', [
      path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
      '--agent', 'agent-symlink',
      '--prompt-file', promptFile,
      '--coord', './coord',
      '--cli', 'fake',
    ], { cwd: project.root, encoding: 'utf-8' });

    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got ${result.status}. stderr:\n${result.stderr}`);
    assert.match(result.stderr, /failed to create coord symlink/, 'error message names the failure');
    assert.match(result.stderr, /Worker cannot run without coord\//, 'error explains the consequence');
    assert.match(result.stderr, /ln -s /, 'error includes a manual workaround');
    // No agent should be registered when spawn-agent.js bails before fork.
    const agents = JSON.parse(fs.readFileSync(path.join(project.root, 'coord', 'agents.json'), 'utf-8'));
    assert.strictEqual(
      agents['agent-symlink'],
      undefined,
      'no agent entry written when symlink fails',
    );
  });
});

describe('spawn-agent.js per-worker coord view isolation', () => {
  let project;
  let worktree;

  before(() => {
    project = createTempProject('spawn-coord-view-');

    const cliPath = path.join(project.root, 'fake-cli.js');
    fs.writeFileSync(cliPath, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf-8');
    writeProjectConfig(project.root, cliPath);
    bootstrapProject(project.root, 'Coord view isolation test');

    const contextPath = path.join(project.root, 'coord', 'context.json');
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
    context.tasks = {
      'agent-view': {
        description: 'Coord view isolation agent.',
        cli: 'fake',
        allowed_paths: ['*.txt'],
      },
    };
    fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

    addKiloWorktree(project.root, 'agent-view');
    worktree = path.join(project.root, '.agents', 'worktrees', 'agent-view');
  });

  after(() => {
    if (project) project.cleanup();
  });

  it('hides agents.json/events.jsonl/prompts/logs and snapshots DECISIONS.md so worker writes do not reach the orchestrator', () => {
    const coordDir = path.join(project.root, 'coord');
    const realDecisions = path.join(coordDir, 'DECISIONS.md');
    const realAgents = path.join(coordDir, 'agents.json');
    const realDecisionsSentinel = '## Orchestrator-owned decisions\n\nDO NOT REWRITE FROM A WORKER.\n';
    fs.writeFileSync(realDecisions, realDecisionsSentinel, 'utf-8');
    // Seed agents.json with a known entry so we can assert it survives any worker-side write.
    fs.writeFileSync(realAgents, JSON.stringify({ 'sentinel-agent': { status: 'sentinel' } }, null, 2));

    const promptFile = path.join(project.root, 'worker-view-prompt.txt');
    fs.writeFileSync(promptFile, 'unused prompt', 'utf-8');

    const result = spawnSync('node', [
      path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
      '--agent', 'agent-view',
      '--prompt-file', promptFile,
      '--coord', './coord',
      '--cli', 'fake',
    ], { cwd: project.root, encoding: 'utf-8' });
    assert.strictEqual(result.status, 0, `spawn-agent failed: ${result.stderr}`);

    // 1. worktree/coord is a symlink to a per-worker view, NOT the real coord/.
    const coordLink = path.join(worktree, 'coord');
    assert.strictEqual(fs.lstatSync(coordLink).isSymbolicLink(), true, 'coord must be a symlink');
    const linkTarget = fs.realpathSync(coordLink);
    assert.notStrictEqual(
      linkTarget,
      fs.realpathSync(coordDir),
      'coord symlink should NOT resolve to the real coord/ directory',
    );
    assert.match(linkTarget, /coord-views/, 'coord symlink should resolve into coord-views/');

    // 2. Forbidden surfaces are not exposed through the worker view.
    for (const name of ['agents.json', 'events.jsonl', 'prompts', 'logs', 'requests.jsonl', 'orchestrator.log']) {
      assert.strictEqual(
        fs.existsSync(path.join(coordLink, name)),
        false,
        `${name} must not be reachable from inside the worktree`,
      );
    }

    // 3. DECISIONS.md is a snapshot copy — worker writes don't reach the real file.
    const workerDecisions = path.join(coordLink, 'DECISIONS.md');
    assert.strictEqual(fs.existsSync(workerDecisions), true, 'worker view must expose DECISIONS.md');
    assert.strictEqual(
      fs.lstatSync(workerDecisions).isSymbolicLink(),
      false,
      'DECISIONS.md must be a snapshot copy, not a symlink',
    );
    assert.strictEqual(
      fs.readFileSync(workerDecisions, 'utf-8'),
      realDecisionsSentinel,
      'snapshot should match the orchestrator-owned content at spawn time',
    );
    fs.writeFileSync(workerDecisions, 'WORKER OVERWRITE — must not reach the orchestrator\n', 'utf-8');
    assert.strictEqual(
      fs.readFileSync(realDecisions, 'utf-8'),
      realDecisionsSentinel,
      'worker write to coord/DECISIONS.md must not mutate the orchestrator\'s file',
    );

    // 4. A worker write to coord/agents.json creates a new file inside the view
    //    but the orchestrator's real agents.json is untouched.
    fs.writeFileSync(path.join(coordLink, 'agents.json'), '{"hijacked": true}\n', 'utf-8');
    const realAgentsAfter = JSON.parse(fs.readFileSync(realAgents, 'utf-8'));
    assert.ok(
      realAgentsAfter['sentinel-agent'],
      'worker write to coord/agents.json must not destroy the real agents.json',
    );
    assert.strictEqual(realAgentsAfter['sentinel-agent'].status, 'sentinel');

    // 5. requests/ and progress/ remain live symlinks (validated ingress paths).
    assert.strictEqual(
      fs.realpathSync(path.join(coordLink, 'requests')),
      fs.realpathSync(path.join(coordDir, 'requests')),
    );
    assert.strictEqual(
      fs.realpathSync(path.join(coordLink, 'progress')),
      fs.realpathSync(path.join(coordDir, 'progress')),
    );

    // 6. decisions.json + decisions.jsonl remain live symlinks (recent + audit).
    assert.strictEqual(
      fs.realpathSync(path.join(coordLink, 'decisions.json')),
      fs.realpathSync(path.join(coordDir, 'decisions.json')),
    );
    assert.strictEqual(
      fs.realpathSync(path.join(coordLink, 'decisions.jsonl')),
      fs.realpathSync(path.join(coordDir, 'decisions.jsonl')),
    );

    // Read the spawned agent's pid so the cleanup hook can take it down.
    const agents = JSON.parse(fs.readFileSync(realAgents, 'utf-8'));
    const pid = agents['agent-view']?.pid;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  });
});
