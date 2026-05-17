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

const materializeScript = path.join(repoRoot(), 'scripts', 'materialize-plan.js');
const validateContextScript = path.join(repoRoot(), 'scripts', 'validate-context.js');
const {
  buildCallerContextMarkdown,
  buildContextFromDraftPlan,
  buildDecisionsMarkdown,
  parseArgs,
} = require('../scripts/materialize-plan');

describe('materialize-plan runner', () => {
  it('writes compact context.json and durable DECISIONS.md from a reviewed draft plan', () => {
    let project;
    try {
      project = createTempProject('materialize-plan-');
      bootstrapProject(project.root, 'Starter automation');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const existing = readJson(contextPath);
      existing.chat_context = {
        preferences: ['Keep generated context compact'],
        gotchas: ['Background loop cannot see the original chat'],
      };
      fs.writeFileSync(contextPath, JSON.stringify(existing, null, 2) + '\n');

      const draftPath = writeDraft(project.root, draftPlan());
      const result = runMaterialize(project.root, [
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
        '--coord',
        './coord',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Materialized context: coord\/context\.json/);
      assert.match(result.stdout, /Next validation: node .*validate-context\.js --coord \.\/coord/);

      const context = readJson(contextPath);
      assert.strictEqual(context.project, 'Starter Session Automation');
      assert.deepStrictEqual(context.chat_context.preferences, ['Keep generated context compact']);
      assert.deepStrictEqual(context.requirements, ['Add prepare-run starter pipeline', 'Keep caller approval loop']);
      assert.deepStrictEqual(context.constraints, ['Planner and reviewers are read-only']);
      assert.deepStrictEqual(context.execution_topology, {
        execution_mode: 'parallel',
        reason: 'Validation foundation is already in place, so conversion and docs can proceed independently.',
        dependency_notes: [
          'Validation foundation already committed.',
          'Shared foundation: No new shared package files.',
        ],
      });
      assert.deepStrictEqual(context.foundation, {
        status: 'not_required',
        paths: [],
      });
      assert.deepStrictEqual(context.tasks['agent-conversion'], {
        description: 'Build the conversion script.',
        read_first: ['scripts/draft-plan.js', 'scripts/lib/context-validation.js'],
        allowed_paths: ['scripts/materialize-plan.js', 'tests/materialize-plan.test.js'],
        forbidden_paths: ['coord/', '.gitignore', 'README.md'],
        validation_command: ['node', '--test', 'tests/materialize-plan.test.js'],
      });
      assert.deepStrictEqual(context.tasks['agent-docs'].validation_command, null);
      assert.strictEqual(context.tasks['agent-conversion'].sequencing_notes, undefined);

      const decisions = fs.readFileSync(path.join(project.root, 'coord', 'DECISIONS.md'), 'utf-8');
      assert.match(decisions, /## Final Execution Topology/);
      assert.match(decisions, /Mode: parallel/);
      assert.match(decisions, /direct: Too much for the caller session/);
      assert.match(decisions, /### Foundation Contract/);
      assert.match(decisions, /Status: not_required/);
      assert.match(decisions, /## File Ownership/);
      assert.match(decisions, /### agent-conversion/);
      assert.match(decisions, /Allowed paths: scripts\/materialize-plan\.js, tests\/materialize-plan\.test\.js/);
      assert.match(decisions, /Validation command: `\["node","--test","tests\/materialize-plan\.test\.js"\]`/);
      assert.match(decisions, /Source draft plan: coord\/plan-reviews\/draft-plan-v1\.json/);

      const callerContext = fs.readFileSync(path.join(project.root, 'coord', 'CALLER_CONTEXT.md'), 'utf-8');
      assert.match(callerContext, /# Caller Context/);
      assert.match(callerContext, /preferences: Keep generated context compact/);
      assert.match(callerContext, /gotchas: Background loop cannot see the original chat/);
      assert.match(callerContext, /Selected topology during draft planning: parallel/);
      assert.match(callerContext, /Source draft plan: coord\/plan-reviews\/draft-plan-v1\.json/);

      const validate = spawnSync(process.execPath, [validateContextScript, '--coord', './coord'], {
        cwd: project.root,
        encoding: 'utf-8',
      });
      assert.strictEqual(validate.status, 0, validate.stderr);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('refuses to overwrite an existing task map unless --force is provided', () => {
    let project;
    try {
      project = createTempProject('materialize-force-');
      bootstrapProject(project.root, 'Force materialization');
      writeDraft(project.root, draftPlan());

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.execution_topology = {
        execution_mode: 'single_worker',
        reason: 'Manual context exists.',
        dependency_notes: [],
      };
      context.tasks = {
        manual: {
          description: 'Manual task',
          allowed_paths: ['manual/**'],
          forbidden_paths: ['coord/'],
          validation_command: null,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

      const blocked = runMaterialize(project.root, [
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
      ]);
      assert.notStrictEqual(blocked.status, 0);
      assert.match(blocked.stderr, /already contains 1 task/);

      const forced = runMaterialize(project.root, [
        '--draft-plan',
        './coord/plan-reviews/draft-plan-v1.json',
        '--force',
      ]);
      assert.strictEqual(forced.status, 0, forced.stderr);
      assert.ok(readJson(contextPath).tasks['agent-conversion']);
    } finally {
      if (project) project.cleanup();
    }
  });

  it('materializes direct mode without creating worker tasks or launch instructions', () => {
    let project;
    try {
      project = createTempProject('materialize-direct-');
      const draftPath = writeDraft(project.root, draftPlan({
        mode: 'direct',
        tasks: {},
      }));

      const result = runMaterialize(project.root, [
        '--draft-plan',
        path.relative(project.root, draftPath),
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Execution topology is direct/);
      assert.doesNotMatch(result.stdout, /Next launch/);

      const context = readJson(path.join(project.root, 'coord', 'context.json'));
      assert.deepStrictEqual(context.tasks, {});
      assert.strictEqual(context.execution_topology.execution_mode, 'direct');
      assert.match(
        fs.readFileSync(path.join(project.root, 'coord', 'DECISIONS.md'), 'utf-8'),
        /Direct mode: no worker file ownership/
      );
    } finally {
      if (project) project.cleanup();
    }
  });

  it('parses CLI args and helper builders deterministically', () => {
    assert.deepStrictEqual(parseArgs([
      '--from-draft-plan',
      'draft.json',
      '--coord',
      './state',
      '--force',
    ]), {
      coordDir: './state',
      draftPlan: 'draft.json',
      force: true,
      help: false,
    });
    assert.strictEqual(parseArgs(['--help']).help, true);
    assert.throws(() => parseArgs([]), /--draft-plan is required/);
    assert.throws(() => parseArgs(['--draft-plan']), /--draft-plan requires a value/);
    assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);

    const context = buildContextFromDraftPlan(draftPlan(), {
      existingContext: {
        created_at: '2026-01-01T00:00:00.000Z',
        chat_context: 'legacy string should not leak',
      },
      generatedAt: '2026-02-01T00:00:00.000Z',
    });
    assert.strictEqual(context.created_at, '2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(context.chat_context, {});

    const decisions = buildDecisionsMarkdown(draftPlan({
      tasks: {},
      mode: 'direct',
    }), {
      sourceDraft: 'draft.json',
      generatedAt: '2026-02-01T00:00:00.000Z',
    });
    assert.match(decisions, /Source draft plan: draft\.json/);
    assert.match(decisions, /Generated at: 2026-02-01T00:00:00\.000Z/);

    const callerContext = buildCallerContextMarkdown(draftPlan(), {
      existingContext: {
        chat_context: {
          preferences: ['Prefer staged sessions'],
          summary: 'User approved session boundaries',
        },
      },
      sourceDraft: 'draft.json',
      generatedAt: '2026-02-01T00:00:00.000Z',
      coordDir: './coord',
      projectRoot: '/tmp/project',
    });
    assert.match(callerContext, /preferences: Prefer staged sessions/);
    assert.match(callerContext, /summary: User approved session boundaries/);
    assert.match(callerContext, /Project root at materialization: \/tmp\/project/);
  });

  it('rejects invalid draft plans before writing coordination files', () => {
    let project;
    try {
      project = createTempProject('materialize-invalid-');
      const draftPath = writeDraft(project.root, {
        project: 'Invalid',
        user_requirements: [],
        constraints: [],
        shared_foundation_assumptions: [],
        known_risks: [],
        candidate_execution_topology: {
          execution_mode: 'parallel',
          reason: 'Invalid because no tasks.',
          rejected_alternatives: [],
          dependency_notes: [],
          shared_foundation_notes: [],
          mode_specific_decomposition: [],
        },
        tasks: {},
      });

      const result = runMaterialize(project.root, ['--draft-plan', path.relative(project.root, draftPath)]);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Draft plan is not valid/);
      assert.match(result.stderr, /parallel topology must include at least two worker tasks/);
      assert.ok(!fs.existsSync(path.join(project.root, 'coord', 'context.json')));
    } finally {
      if (project) project.cleanup();
    }
  });
});

function runMaterialize(cwd, args) {
  return spawnSync(process.execPath, [materializeScript, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
}

function writeDraft(projectRoot, draft) {
  const draftPath = path.join(projectRoot, 'coord', 'plan-reviews', 'draft-plan-v1.json');
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n', 'utf-8');
  return draftPath;
}

function draftPlan(overrides = {}) {
  const mode = overrides.mode || 'parallel';
  const tasks = overrides.tasks !== undefined ? overrides.tasks : {
        'agent-conversion': {
          description: 'Build the conversion script.',
          allowed_paths: ['scripts/materialize-plan.js', 'tests/materialize-plan.test.js'],
          forbidden_paths: ['coord/', '.gitignore', 'README.md'],
          read_first: ['scripts/draft-plan.js', 'scripts/lib/context-validation.js'],
          validation_command: ['node', '--test', 'tests/materialize-plan.test.js'],
          sequencing_notes: ['Run after draft plan generation lands.'],
        },
    'agent-docs': {
          description: 'Document the conversion flow.',
          allowed_paths: ['README.md', 'SKILL.md', 'references/schemas.md'],
          forbidden_paths: ['scripts/**', 'coord/', '.gitignore'],
          read_first: ['README.md', 'SKILL.md', 'references/schemas.md'],
          validation_command: null,
          sequencing_notes: ['Only edit documentation.'],
        },
  };

  return {
    project: 'Starter Session Automation',
    user_requirements: ['Add prepare-run starter pipeline', 'Keep caller approval loop'],
    constraints: ['Planner and reviewers are read-only'],
    candidate_execution_topology: {
      execution_mode: mode,
      reason: mode === 'direct'
        ? 'Small enough for caller session.'
        : 'Validation foundation is already in place, so conversion and docs can proceed independently.',
      rejected_alternatives: [
        { execution_mode: 'direct', reason: 'Too much for the caller session.' },
        { execution_mode: 'single_worker', reason: 'Could be split safely.' },
      ],
      dependency_notes: ['Validation foundation already committed.'],
      shared_foundation_notes: ['No new shared package files.'],
      mode_specific_decomposition: ['Conversion and docs are separate ownership boundaries.'],
    },
    shared_foundation_assumptions: ['No lockfile or package manifest changes are required.'],
    foundation: {
      status: 'not_required',
      paths: [],
      commit: '',
      owner: '',
    },
    known_risks: ['Generated decisions may need caller edits for project-specific contracts.'],
    tasks,
  };
}
