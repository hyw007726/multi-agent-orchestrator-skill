'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  readJson,
  readJsonl,
  run,
} = require('./helpers/temp-project');

const {
  collectBlockers,
  detectMergeConflicts,
  resolveBaseRef,
} = require('../scripts/integrate-agent');

const integratePath = path.join(repoRoot(), 'scripts', 'integrate-agent.js');

describe('integrate-agent', () => {
  it('blocks needs_attention agents unless --force', () => {
    const blockers = collectBlockers({ status: 'needs_attention' }, { agent: 'agent-a', force: false });
    assert.ok(blockers.length > 0);
    assert.ok(collectBlockers({ status: 'needs_attention' }, { agent: 'agent-a', force: true }).length === 0);
  });

  it('previews diff and applies a clean merge', () => {
    let project;
    try {
      project = setupCompletedAgent('integrate-clean-');
      const agentsPath = path.join(project.root, 'coord', 'agents.json');

      const preview = runIntegrate(project.root, ['--agent', 'agent-a', '--coord', './coord']);
      assert.strictEqual(preview.status, 0, preview.stderr);
      assert.match(preview.stdout, /Preview only/);
      assert.match(preview.stdout, /agent-feature\.txt/);
      assert.ok(fs.existsSync(path.join(project.root, '.agents', 'worktrees', 'agent-a')));

      const apply = runIntegrate(project.root, ['--agent', 'agent-a', '--coord', './coord', '--apply']);
      assert.strictEqual(apply.status, 0, apply.stderr);
      assert.match(apply.stdout, /Applied:/);
      assert.ok(fs.readFileSync(path.join(project.root, 'agent-feature.txt'), 'utf-8').includes('from worker'));
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees', 'agent-a')));

      const agents = readJson(agentsPath);
      assert.ok(agents['agent-a'].integrated_at);
      const baseRef = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.root }).stdout.trim();
      assert.strictEqual(agents['agent-a'].integrated_into, baseRef);

      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      assert.ok(events.some((e) => e.event === 'agent_integrated' && e.agent === 'agent-a'));
    } finally {
      if (project) project.cleanup();
    }
  });

  it('detectMergeConflicts reports conflicts when branches diverge on the same file', () => {
    let project;
    try {
      project = createTempProject('integrate-conflict-');
      run('git', ['worktree', 'add', '.agents/worktrees/agent-a', '-b', 'agent-a'], { cwd: project.root });
      const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-a');
      fs.writeFileSync(path.join(project.root, 'README.md'), '# Main edit\n');
      run('git', ['add', 'README.md'], { cwd: project.root });
      run('git', ['commit', '-m', 'main change'], { cwd: project.root });
      fs.writeFileSync(path.join(worktree, 'README.md'), '# Worker edit\n');
      run('git', ['add', 'README.md'], { cwd: worktree });
      run('git', ['commit', '-m', 'worker change'], { cwd: worktree });

      const baseRef = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.root }).stdout.trim();
      const coordDir = path.join(project.root, 'coord');
      fs.mkdirSync(coordDir, { recursive: true });
      fs.writeFileSync(
        path.join(coordDir, 'agents.json'),
        `${JSON.stringify({
          'agent-a': {
            status: 'completed',
            worktree,
            base_ref: baseRef,
          },
        }, null, 2)}\n`,
      );
      const conflict = detectMergeConflicts(project.root, baseRef, 'agent-a');
      assert.strictEqual(conflict.hasConflicts, true);

      const preview = runIntegrate(project.root, [
        '--agent', 'agent-a',
        '--coord', './coord',
        '--force',
        '--base-ref', baseRef,
        '--branch', 'agent-a',
      ]);
      assert.notStrictEqual(preview.status, 0);
      assert.match(preview.stdout + preview.stderr, /CONFLICT|conflict/i);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('resolveBaseRef prefers explicit flags and agent record', () => {
    let project;
    try {
      project = createTempProject('integrate-base-');
      assert.strictEqual(resolveBaseRef({ base_ref: 'main' }, project.root, 'other'), 'other');
      assert.strictEqual(resolveBaseRef({ base_ref: 'main' }, project.root, undefined), 'main');
    } finally {
      if (project) project.cleanup();
    }
  });
});

function setupCompletedAgent(prefix) {
  const project = createTempProject(prefix);
  const coordDir = path.join(project.root, 'coord');
  fs.mkdirSync(coordDir, { recursive: true });
  const baseRef = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.root }).stdout.trim();

  run('git', ['worktree', 'add', '.agents/worktrees/agent-a', '-b', 'agent-a'], { cwd: project.root });
  const worktree = path.join(project.root, '.agents', 'worktrees', 'agent-a');
  fs.writeFileSync(path.join(worktree, 'agent-feature.txt'), 'from worker\n');
  run('git', ['add', 'agent-feature.txt'], { cwd: worktree });
  run('git', ['commit', '-m', 'worker feature'], { cwd: worktree });

  fs.writeFileSync(
    path.join(coordDir, 'agents.json'),
    `${JSON.stringify({
      'agent-a': {
        status: 'completed',
        task: 'Add feature file',
        worktree,
        base_ref: baseRef,
        cli: 'fake',
      },
    }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(coordDir, 'events.jsonl'), '');
  return project;
}

function runIntegrate(cwd, args) {
  return spawnSync('node', [integratePath, ...args], { cwd, encoding: 'utf-8' });
}
