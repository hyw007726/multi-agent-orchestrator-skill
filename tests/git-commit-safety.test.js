'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempProject } = require('./helpers/temp-project');
const { commitWorktree, stageAllChanges } = require('../scripts/orchestrator-loop');

describe('git commit message safety', () => {
  it('auto-commit messages treat quotes, newlines, and substitutions as literal text', () => {
    let project;
    try {
      project = createTempProject('commit-auto-safe-');
      const pwned = path.join(project.root, 'auto-pwned');
      const backtickPwned = path.join(project.root, 'auto-backtick-pwned');
      const message = [
        'agent-agent-safe: completed "quoted" task',
        `$(touch ${pwned})`,
        `\`touch ${backtickPwned}\``,
      ].join('\n');

      fs.writeFileSync(path.join(project.root, 'auto.txt'), 'auto commit content\n', 'utf-8');
      stageAllChanges(project.root);
      const result = commitWorktree(project.root, message);

      assert.strictEqual(result.committed, true, result.stderr);
      assert.strictEqual(fs.existsSync(pwned), false, 'command substitution should not execute');
      assert.strictEqual(fs.existsSync(backtickPwned), false, 'backtick substitution should not execute');
      assert.match(latestCommitMessage(project.root), /\$\(touch .*auto-pwned\)/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('soft-restart WIP messages treat quotes, newlines, and substitutions as literal text', () => {
    let project;
    try {
      project = createTempProject('commit-wip-safe-');
      const pwned = path.join(project.root, 'wip-pwned');
      const backtickPwned = path.join(project.root, 'wip-backtick-pwned');
      const message = [
        'WIP: orchestrator intervention (soft_restart "quoted")',
        `$(touch ${pwned})`,
        `\`touch ${backtickPwned}\``,
      ].join('\n');

      fs.writeFileSync(path.join(project.root, 'wip.txt'), 'wip commit content\n', 'utf-8');
      stageAllChanges(project.root);
      const result = commitWorktree(project.root, message);

      assert.strictEqual(result.committed, true, result.stderr);
      assert.strictEqual(fs.existsSync(pwned), false, 'command substitution should not execute');
      assert.strictEqual(fs.existsSync(backtickPwned), false, 'backtick substitution should not execute');
      assert.match(latestCommitMessage(project.root), /\$\(touch .*wip-pwned\)/);
    } finally {
      if (project) project.cleanup();
    }
  });
});

function latestCommitMessage(cwd) {
  const result = spawnSync('git', ['log', '-1', '--pretty=%B'], {
    cwd,
    encoding: 'utf-8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}
