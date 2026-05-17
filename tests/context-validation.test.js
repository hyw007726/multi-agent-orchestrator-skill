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
  run,
  readJson,
} = require('./helpers/temp-project');
const { validateContext } = require('../scripts/lib/context-validation');

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

  it('keeps foundation ownership diagnostics advisory when launchability is not required', () => {
    let project;
    try {
      project = createTempProject('context-validation-warn-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Warning context validation project');

      const context = readJson(path.join(project.root, 'coord', 'context.json'));
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Two workers are intentionally broad for warning coverage.',
        dependency_notes: [],
      };
      context.foundation = { status: 'not_required', paths: [] };
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
      const report = validateContext(context, fakeConfig(), {
        projectRoot: project.root,
        coordDir: './coord',
        requireLaunchable: false,
      });

      assert.deepStrictEqual(report.errors, []);
      assert.match(report.warnings.join('\n'), /Possible overlapping ownership/);
      assert.match(report.warnings.join('\n'), /Broad allowed path "tests\/\*\*" is shared by 2 workers/);
      assert.match(report.warnings.join('\n'), /Foundation path/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('blocks parallel launch when foundation ownership is ambiguous', () => {
    let project;
    try {
      project = createTempProject('context-validation-foundation-block-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Foundation blocking project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Foundation paths must be explicit before fan-out.',
        dependency_notes: [],
      };
      context.foundation = { status: 'not_required', paths: [] };
      context.tasks = {
        'agent-alpha': validFanoutTask({ forbidden_paths: ['coord/'] }),
        'agent-beta': validFanoutTask({ forbidden_paths: ['coord/'] }),
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Context validation failed/);
      assert.match(result.stderr, /Foundation path ".gitignore" is not forbidden/);
      assert.match(result.stderr, /Foundation path "orchestrator.config.js" is not forbidden/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('passes completed committed foundation paths when they are clean and forbidden to every worker', () => {
    let project;
    try {
      project = createTempProject('context-validation-foundation-clean-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Clean committed foundation project');
      writePackage(project.root, '{"name":"foundation-clean"}\n');
      run('git', ['add', '.gitignore', 'orchestrator.config.js', 'package.json'], { cwd: project.root });
      run('git', ['commit', '-m', 'Commit foundation files'], { cwd: project.root });

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'phased',
        reason: 'Foundation commit is complete before fan-out.',
        dependency_notes: ['Foundation committed at HEAD.'],
      };
      context.foundation = {
        status: 'completed_committed',
        paths: ['package.json'],
        commit: 'HEAD',
      };
      context.tasks = {
        'agent-alpha': validFanoutTask({ allowed_paths: ['src/alpha/**'], forbidden_paths: allFoundationForbids() }),
        'agent-beta': validFanoutTask({ allowed_paths: ['src/beta/**'], forbidden_paths: allFoundationForbids() }),
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Context validation passed/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('rejects declared completed foundation paths missing from worker forbidden_paths', () => {
    let project;
    try {
      project = createTempProject('context-validation-foundation-missing-forbid-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Missing foundation forbid project');
      writePackage(project.root, '{"name":"foundation-missing-forbid"}\n');
      run('git', ['add', '.gitignore', 'orchestrator.config.js', 'package.json'], { cwd: project.root });
      run('git', ['commit', '-m', 'Commit foundation files'], { cwd: project.root });

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Package manifest must be protected from both workers.',
        dependency_notes: [],
      };
      context.foundation = {
        status: 'completed_committed',
        paths: ['package.json'],
        commit: 'HEAD',
      };
      context.tasks = {
        'agent-alpha': validFanoutTask({ forbidden_paths: allFoundationForbids() }),
        'agent-beta': validFanoutTask({ forbidden_paths: ['coord/', '.gitignore', 'orchestrator.config.js'] }),
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Foundation path "package.json" is not forbidden by tasks\.agent-beta\.forbidden_paths/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('rejects completed foundation paths with uncommitted changes', () => {
    let project;
    try {
      project = createTempProject('context-validation-foundation-dirty-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Dirty foundation project');
      writePackage(project.root, '{"name":"foundation-dirty"}\n');
      run('git', ['add', '.gitignore', 'orchestrator.config.js', 'package.json'], { cwd: project.root });
      run('git', ['commit', '-m', 'Commit foundation files'], { cwd: project.root });
      writePackage(project.root, '{"name":"foundation-dirty","private":true}\n');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'Dirty foundation paths should block launch.',
        dependency_notes: [],
      };
      context.foundation = {
        status: 'completed_committed',
        paths: ['package.json'],
        commit: 'HEAD',
      };
      context.tasks = {
        'agent-alpha': validFanoutTask({ forbidden_paths: allFoundationForbids() }),
        'agent-beta': validFanoutTask({ forbidden_paths: allFoundationForbids() }),
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /listed foundation paths have uncommitted changes/);
      assert.match(result.stderr, /package\.json/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('allows exactly one declared worker to own a foundation path', () => {
    let project;
    try {
      project = createTempProject('context-validation-foundation-owner-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Owned foundation project');
      writePackage(project.root, '{"name":"foundation-owner"}\n');
      run('git', ['add', '.gitignore', 'orchestrator.config.js', 'package.json'], { cwd: project.root });
      run('git', ['commit', '-m', 'Commit baseline files'], { cwd: project.root });

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'parallel',
        reason: 'One worker intentionally owns package.json.',
        dependency_notes: ['agent-alpha owns package.json.'],
      };
      context.foundation = {
        status: 'owned_by_worker',
        paths: ['package.json'],
        owner: 'agent-alpha',
      };
      context.tasks = {
        'agent-alpha': validFanoutTask({
          allowed_paths: ['package.json', 'src/alpha/**'],
          forbidden_paths: ['coord/', '.gitignore', 'orchestrator.config.js'],
        }),
        'agent-beta': validFanoutTask({
          allowed_paths: ['src/beta/**'],
          forbidden_paths: allFoundationForbids(),
        }),
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Context validation passed/);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('does not require foundation state for single-worker launch contexts', () => {
    let project;
    try {
      project = createTempProject('context-validation-single-no-foundation-');
      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Single worker no foundation project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      delete context.foundation;
      context.execution_topology = {
        execution_mode: 'single_worker',
        reason: 'Single worker does not need fan-out foundation ownership.',
        dependency_notes: [],
      };
      context.tasks = {
        'agent-one': {
          description: 'One worker.',
          cli: 'fake',
          allowed_paths: ['src/**'],
          forbidden_paths: ['coord/'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.strictEqual(result.status, 0, result.stderr);
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

  it('rejects worker CLI aliases without health checks', () => {
    let project;
    try {
      project = createTempProject('context-validation-health-alias-');
      const configPath = path.join(project.root, 'orchestrator.config.js');
      fs.writeFileSync(configPath, [
        'module.exports = {',
        '  default_cli: "fake-alias",',
        '  orchestrator_cli: "fake-alias",',
        '  cli_templates: {',
        `    "fake-alias": { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fakeCliPath)}, { prompt_file: true }] },`,
        '  },',
        '};',
      ].join('\n') + '\n');
      bootstrapProject(project.root, 'Health alias validation project');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'single_worker',
        reason: 'Alias needs preflight coverage.',
        dependency_notes: [],
      };
      context.tasks = {
        'agent-alias': {
          description: 'Use a CLI alias.',
          cli: 'fake-alias',
          allowed_paths: ['src/**'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const result = runValidateContext(project.root);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /cli "fake-alias" has no cli_health_checks\.fake-alias entry/);
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

function fakeConfig() {
  return {
    default_cli: 'fake',
    cli_templates: {
      fake: { cmd: process.execPath, args: [fakeCliPath, { prompt_file: true }] },
    },
    cli_health_checks: {
      fake: 'node --version',
    },
  };
}

function validFanoutTask(overrides = {}) {
  return {
    description: 'Implement worker slice.',
    cli: 'fake',
    allowed_paths: ['src/**'],
    forbidden_paths: ['coord/'],
    validation_command: null,
    ...overrides,
  };
}

function allFoundationForbids() {
  return ['coord/', '.gitignore', 'orchestrator.config.js', 'package.json'];
}

function writePackage(projectRoot, contents) {
  fs.writeFileSync(path.join(projectRoot, 'package.json'), contents, 'utf-8');
}
