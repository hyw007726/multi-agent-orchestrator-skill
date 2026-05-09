'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  readJson,
} = require('./helpers/temp-project');

const fakeCliPath = path.join(repoRoot(), 'tests/helpers/fake-cli.js');
const validateContextScript = path.join(repoRoot(), 'scripts', 'validate-context.js');
const launchAllScript = path.join(repoRoot(), 'scripts', 'launch-all.js');

describe('context validation', () => {
  it('rejects underspecified starter artifacts with actionable diagnostics', () => {
    let project;
    try {
      project = createTempProject('context-validation-bad-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Bad context validation project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Exercise strict validation.',
        dependency_notes: [],
      };
      context.tasks = {
        'agent-bad': {
          description: '',
          cli: 'missingcli',
          allowed_paths: [],
          validation_command: ['node', 42],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Context validation failed/);
      assert.match(result.stderr, /tasks\.agent-bad\.description is required/);
      assert.match(result.stderr, /cli "missingcli" has no cli_templates\.missingcli entry/);
      assert.match(result.stderr, /allowed_paths must contain at least 1 path/);
      assert.match(result.stderr, /validation_command\[1\] must be a non-empty string/);
      assert.match(result.stderr, /coord\/context\.json/);
      assert.match(result.stderr, /coord\/DECISIONS\.md/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('warns about shared ownership and missing foundational forbidden paths without blocking launch-readiness', () => {
    let project;
    try {
      project = createTempProject('context-validation-warn-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Warning context validation project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Two workers are intentionally broad for warning coverage.',
        dependency_notes: [],
      };
      context.tasks = {
        'agent-alpha': {
          description: 'Implement alpha.',
          cli: 'fake',
          allowed_paths: ['tests/**'],
          forbidden_paths: ['beta/**'],
          validation_command: null,
        },
        'agent-beta': {
          description: 'Implement beta.',
          cli: 'fake',
          allowed_paths: ['tests/**'],
          forbidden_paths: ['alpha/**'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Context validation warnings/);
      assert.match(result.stdout, /Possible overlapping ownership/);
      assert.match(result.stdout, /Broad allowed path "tests\/\*\*" is shared by 2 workers/);
      assert.match(result.stdout, /foundational paths/);
      assert.match(result.stdout, /Context validation passed with warnings/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('launch-all runs validation before creating worktrees', () => {
    let project;
    try {
      project = createTempProject('context-validation-launch-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Launch validation project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'single_worker',
        reason: 'Invalid task should stop before worktree creation.',
        dependency_notes: [],
      };
      context.tasks = {
        'agent-invalid': {
          description: 'This task is missing ownership boundaries.',
          cli: 'fake',
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = spawnSync('node', [launchAllScript, '--coord', './coord'], {
        cwd: project.root,
        encoding: 'utf-8',
      });

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Context validation failed/);
      assert.match(result.stderr, /allowed_paths is required/);
      assert.match(result.stderr, /validate-context\.js/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));
      assert.ok(!fs.existsSync(path.join(project.root, '.kilocode', 'worktrees')));
    } finally {
      if (project) project.cleanup();
    }
  });
});

function runValidateContext(cwd) {
  return spawnSync('node', [validateContextScript, '--coord', './coord'], {
    cwd,
    encoding: 'utf-8',
  });
}
