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
