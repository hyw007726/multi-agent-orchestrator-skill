'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  repoRoot,
  createTempProject,
  bootstrapProject,
  readJson,
} = require('./helpers/temp-project');

const draftPlanScript = path.join(repoRoot(), 'scripts', 'draft-plan.js');
const {
  buildRepoScanSummary,
  parseArgs,
  renderPlannerPrompt,
  validateDraftPlan,
} = require('../scripts/draft-plan');

describe('draft-plan runner', () => {
  it('invokes the configured planner CLI and writes canonical draft artifacts', () => {
    let project;
    try {
      project = createTempProject('draft-plan-success-');
      const plannerPath = writePlanner(project.root, 'planner.js', [
        'const fs = require("node:fs");',
        'const prompt = fs.readFileSync(process.argv[2], "utf-8");',
        'if (!prompt.includes("Do not edit files, create worktrees, create branches, launch workers")) process.exit(10);',
        'if (!prompt.includes("## Repository Scan Summary")) process.exit(11);',
        'if (!prompt.includes("Add starter automation")) process.exit(12);',
        'process.stdout.write("planner chatter before json\\n");',
        'process.stdout.write(JSON.stringify({',
        '  project: "Starter automation",',
        '  user_requirements: ["Add starter automation"],',
        '  constraints: ["Planner is read-only"],',
        '  candidate_execution_topology: {',
        '    execution_mode: "parallel",',
        '    reason: "Independent script and docs boundaries after foundation.",',
        '    rejected_alternatives: [',
        '      { execution_mode: "direct", reason: "Too large." },',
        '      { execution_mode: "single_worker", reason: "Can split safely." },',
        '      { execution_mode: "phased", reason: "No shared foundation required in this fake plan." }',
        '    ],',
        '    dependency_notes: ["Keep workers disjoint."],',
        '    shared_foundation_notes: ["Shared validation already exists."],',
        '    mode_specific_decomposition: ["Two workers can proceed in parallel."]',
        '  },',
        '  shared_foundation_assumptions: ["Validation foundation is already committed."],',
        '  known_risks: ["Path ownership can drift."],',
        '  tasks: {',
        '    "agent-script": {',
        '      description: "Implement script work.",',
        '      allowed_paths: ["scripts/**", "tests/draft-plan.test.js"],',
        '      forbidden_paths: ["README.md", "coord/"],',
        '      read_first: ["scripts/review-plan.js"],',
        '      validation_command: ["node", "--test", "tests/draft-plan.test.js"],',
        '      sequencing_notes: ["Run after validation foundation."]',
        '    },',
        '    "agent-docs": {',
        '      description: "Update docs.",',
        '      allowed_paths: ["README.md", "SKILL.md"],',
        '      forbidden_paths: ["scripts/**", "coord/"],',
        '      read_first: ["README.md", "SKILL.md"],',
        '      validation_command: null,',
        '      sequencing_notes: ["Only docs edits."]',
        '    }',
        '  }',
        '}));',
      ]);
      writePlannerConfig(project.root, plannerPath);
      bootstrapProject(project.root, 'Starter automation');

      const result = runDraftPlan(project.root, [
        '--task',
        'Add starter automation',
        '--project',
        'Starter automation',
        '--coord',
        './coord',
        '--timeout-ms',
        '1000',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Draft planner: invoking plannerfake/);
      assert.match(result.stdout, /Canonical draft plan: coord\/plan-reviews\/draft-plan-v1\.json/);
      assert.match(result.stdout, /review-plan\.js --iteration 1/);

      const draftPath = path.join(project.root, 'coord', 'plan-reviews', 'draft-plan-v1.json');
      const promptPath = path.join(project.root, 'coord', 'plan-reviews', 'draft-plan-v1.prompt.md');
      const rawPath = path.join(project.root, 'coord', 'plan-reviews', 'draft-plan-v1.raw.md');
      const draft = readJson(draftPath);

      assert.strictEqual(draft.candidate_execution_topology.execution_mode, 'parallel');
      assert.deepStrictEqual(Object.keys(draft.tasks), ['agent-script', 'agent-docs']);
      assert.match(fs.readFileSync(promptPath, 'utf-8'), /Required JSON response shape/);
      assert.match(fs.readFileSync(rawPath, 'utf-8'), /planner chatter before json/);
      assert.ok(!fs.existsSync(path.join(project.root, '.agents', 'worktrees')));
      assert.ok(!fs.existsSync(path.join(project.root, '.kilocode', 'worktrees')));
    } finally {
      if (project) project.cleanup();
    }
  });

  it('rejects invalid planner JSON and preserves the raw stream for inspection', () => {
    let project;
    try {
      project = createTempProject('draft-plan-invalid-');
      const plannerPath = writePlanner(project.root, 'bad-planner.js', [
        'process.stdout.write(JSON.stringify({ project: "Bad", candidate_execution_topology: { execution_mode: "parallel" }, tasks: {} }));',
      ]);
      writePlannerConfig(project.root, plannerPath);

      const result = runDraftPlan(project.root, [
        '--task',
        'Make an invalid plan',
        '--timeout-ms',
        '1000',
      ]);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Planner JSON failed draft-plan validation/);
      assert.match(result.stderr, /user_requirements must be an array/);
      assert.match(result.stderr, /parallel topology must include at least two worker tasks/);
      assert.ok(fs.existsSync(path.join(project.root, 'coord', 'plan-reviews', 'draft-plan-v1.raw.md')));
      assert.ok(!fs.existsSync(path.join(project.root, 'coord', 'plan-reviews', 'draft-plan-v1.json')));
    } finally {
      if (project) project.cleanup();
    }
  });

  it('parses CLI arguments and rejects ambiguous or malformed input', () => {
    assert.deepStrictEqual(parseArgs([
      '--task',
      'Do work',
      '--project',
      'Demo',
      '--coord',
      './state',
      '--repo-scan-summary',
      'scan.json',
      '--timeout-ms',
      '25',
      '--force',
    ]), {
      coordDir: './state',
      project: 'Demo',
      task: 'Do work',
      taskFile: '',
      repoScanSummary: 'scan.json',
      timeoutMs: 25,
      force: true,
      help: false,
    });

    assert.strictEqual(parseArgs(['--help']).help, true);
    assert.strictEqual(parseArgs(['-h']).help, true);
    assert.throws(() => parseArgs([]), /--task or --task-file is required/);
    assert.throws(() => parseArgs(['--task', 'x', '--task-file', 'task.md']), /either --task or --task-file/);
    assert.throws(() => parseArgs(['--task', 'x', '--timeout-ms', '0']), /positive integer/);
    assert.throws(() => parseArgs(['--task']), /--task requires a value/);
    assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
  });

  it('validates draft-plan shapes across topology and task edge cases', () => {
    assert.deepStrictEqual(validateDraftPlan(null), {
      ok: false,
      errors: ['Draft plan must be a JSON object.'],
    });

    const direct = validPlan({ mode: 'direct', tasks: {} });
    assert.strictEqual(validateDraftPlan(direct).ok, true);

    const single = validPlan({
      mode: 'single_worker',
      tasks: {
        'agent-one': validTask({ validation_command: 'node scripts/run-tests.js' }),
      },
    });
    assert.strictEqual(validateDraftPlan(single).ok, true);

    const directWithTask = validPlan({
      mode: 'direct',
      tasks: { 'agent-unneeded': validTask() },
    });
    assert.match(validateDraftPlan(directWithTask).errors.join('\n'), /direct topology must not include worker tasks/);

    const tooManySingle = validPlan({
      mode: 'single_worker',
      tasks: { one: validTask(), two: validTask() },
    });
    assert.match(validateDraftPlan(tooManySingle).errors.join('\n'), /single_worker topology must include exactly one task/);

    const tooFewParallel = validPlan({
      mode: 'phased',
      tasks: { one: validTask() },
    });
    assert.match(validateDraftPlan(tooFewParallel).errors.join('\n'), /phased topology must include at least two worker tasks/);

    const invalid = {
      project: '',
      user_requirements: [42],
      constraints: 'not-array',
      shared_foundation_assumptions: [],
      known_risks: [],
      candidate_execution_topology: {
        execution_mode: 'bogus',
        reason: '',
        rejected_alternatives: [
          'bad',
          { execution_mode: 'bogus', reason: '' },
        ],
        dependency_notes: 'bad',
        shared_foundation_notes: [null],
      },
      tasks: {
        'bad name': {
          description: '',
          allowed_paths: [],
          forbidden_paths: [1],
          read_first: 'bad',
          sequencing_notes: [null],
          validation_command: [],
        },
        'agent-not-object': 'nope',
      },
    };
    const errors = validateDraftPlan(invalid).errors.join('\n');
    assert.match(errors, /project must be a non-empty string/);
    assert.match(errors, /user_requirements\[0\] must be a non-empty string/);
    assert.match(errors, /constraints must be an array/);
    assert.match(errors, /execution_mode must be direct/);
    assert.match(errors, /rejected_alternatives\[0\] must be an object/);
    assert.match(errors, /rejected_alternatives\[1\]\.execution_mode is invalid/);
    assert.match(errors, /bad name.*unsafe name/);
    assert.match(errors, /allowed_paths must contain at least 1 item/);
    assert.match(errors, /validation_command must not be an empty array/);
    assert.match(errors, /agent-not-object must be an object/);

    assert.match(
      validateDraftPlan({ ...validPlan({ mode: 'parallel', tasks: {} }), tasks: [] }).errors.join('\n'),
      /tasks must be an object/
    );
    assert.match(
      validateDraftPlan({ ...validPlan({ mode: 'parallel', tasks: {} }), candidate_execution_topology: null }).errors.join('\n'),
      /candidate_execution_topology must be an object/
    );
  });

  it('summarizes repository files, package scripts, dependencies, and validation candidates', () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'draft-plan-scan-'));
    try {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        scripts: {
          test: 'node --test',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          check: 'node scripts/run-tests.js',
        },
        dependencies: { react: '^19.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      }, null, 2));
      fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'scripts', 'run-tests.js'), 'console.log("ok");\n');
      fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tests', 'sample.test.js'), 'console.log("test");\n');
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'index.js'), 'console.log("src");\n');
      fs.mkdirSync(path.join(tmp, 'coord'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'coord', 'secret.json'), '{}\n');
      fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');

      const summary = buildRepoScanSummary(tmp, path.join(tmp, 'coord'));

      assert.strictEqual(summary.package_manager, 'pnpm');
      assert.deepStrictEqual(summary.package_dependencies, ['react']);
      assert.deepStrictEqual(summary.package_dev_dependencies, ['typescript']);
      assert.deepStrictEqual(summary.package_scripts, {
        test: 'node --test',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        check: 'node scripts/run-tests.js',
      });
      assert.ok(summary.candidate_validation_commands.some((cmd) => cmd.join(' ') === 'pnpm run test'));
      assert.ok(summary.candidate_validation_commands.some((cmd) => cmd.join(' ') === 'node scripts/run-tests.js'));
      assert.ok(summary.candidate_validation_commands.some((cmd) => cmd.join(' ') === 'node --test'));
      assert.ok(summary.repo_files_sample.includes('src/index.js'));
      assert.ok(!summary.repo_files_sample.includes('coord/secret.json'));
      assert.ok(!summary.repo_files_sample.includes('node_modules/pkg/index.js'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('renders planner prompts with the read-only contract and response schema', () => {
    const prompt = renderPlannerPrompt({
      project: 'Demo',
      taskText: 'Split a starter workflow',
      repoScan: '{"files":[]}',
      coordDir: './coord',
    });

    assert.match(prompt, /read-only initial decomposition planner/);
    assert.match(prompt, /Do not edit files, create worktrees/);
    assert.match(prompt, /direct, single_worker, parallel, or phased/);
    assert.match(prompt, /"candidate_execution_topology"/);
    assert.match(prompt, /Split a starter workflow/);
  });
});

function runDraftPlan(cwd, args) {
  return spawnSync(process.execPath, [draftPlanScript, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
}

function writePlannerConfig(projectRoot, plannerPath) {
  fs.writeFileSync(path.join(projectRoot, 'orchestrator.config.js'), [
    'module.exports = {',
    '  default_cli: "workerfake",',
    '  orchestrator_cli: "orchestratorfake",',
    '  planner_cli: "plannerfake",',
    '  launch_dashboard: false,',
    '  cli_templates: {',
    `    workerfake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(plannerPath)}, { prompt_file: true }] },`,
    `    orchestratorfake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(plannerPath)}, { prompt_file: true }] },`,
    `    plannerfake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(plannerPath)}, { prompt_file: true }] },`,
    '  },',
    '  cli_health_checks: {',
    '    workerfake: "node --version",',
    '    orchestratorfake: "node --version",',
    '    plannerfake: "node --version",',
    '  },',
    '};',
  ].join('\n') + '\n', 'utf-8');
}

function writePlanner(projectRoot, name, bodyLines) {
  const file = path.join(projectRoot, name);
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "'use strict';",
    ...bodyLines,
  ].join('\n') + '\n', 'utf-8');
  return file;
}

function validPlan({ mode = 'parallel', tasks } = {}) {
  return {
    project: 'Demo',
    user_requirements: ['Do work'],
    constraints: ['Stay read-only while planning'],
    candidate_execution_topology: {
      execution_mode: mode,
      reason: 'Appropriate topology.',
      rejected_alternatives: [
        { execution_mode: 'direct', reason: 'Not enough delegation.' },
      ],
      dependency_notes: ['No dependencies.'],
      shared_foundation_notes: ['No shared foundations.'],
      mode_specific_decomposition: ['Split safely.'],
    },
    shared_foundation_assumptions: ['Foundation exists.'],
    known_risks: ['Merge conflicts.'],
    tasks: tasks === undefined
      ? {
          one: validTask(),
          two: validTask(),
        }
      : tasks,
  };
}

function validTask(overrides = {}) {
  return {
    description: 'Do task work.',
    allowed_paths: ['src/**'],
    forbidden_paths: ['coord/'],
    read_first: ['README.md'],
    validation_command: ['node', '--test'],
    sequencing_notes: ['No sequencing.'],
    ...overrides,
  };
}
