'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  createTempProject,
  bootstrapProject,
  repoRoot,
  run,
  readJson,
} = require('./helpers/temp-project');

describe('bootstrap example file', () => {
  it('writes coord/context.example.json with a valid example agent entry', () => {
    let project;
    try {
      project = createTempProject('bootstrap-example');
      bootstrapProject(project.root, 'Test project for bootstrap example');

      const examplePath = path.join(project.root, 'coord', 'context.example.json');
      const example = readJson(examplePath);
      const decisionAuditPath = path.join(project.root, 'coord', 'decisions.jsonl');

      assert.ok(fs.existsSync(decisionAuditPath), 'bootstrap should create decisions.jsonl');

      assert.ok(example.execution_topology, 'should have execution topology object');
      assert.strictEqual(example.execution_topology.execution_mode, 'single_worker');
      assert.strictEqual(typeof example.execution_topology.reason, 'string');
      assert.ok(Array.isArray(example.execution_topology.dependency_notes));
      assert.ok(example.execution_topology.dependency_notes.length > 0);

      assert.ok(example.tasks, 'should have tasks object');
      const agentNames = Object.keys(example.tasks);
      assert.strictEqual(agentNames.length, 1, 'should have exactly one agent entry');

      const agent = example.tasks[agentNames[0]];

      const requiredFields = [
        'description',
        'cli',
        'mode',
        'read_first',
        'allowed_paths',
        'forbidden_paths',
        'validation_command',
        'timeout_mins',
        'progress_timeout_mins',
      ];

      for (const field of requiredFields) {
        assert.ok(field in agent, `agent entry must have field "${field}"`);
      }

      assert.strictEqual(typeof agent.description, 'string');
      assert.ok(agent.description.length > 0);
      assert.strictEqual(typeof agent.cli, 'string');
      assert.ok(agent.cli.length > 0);
      assert.strictEqual(typeof agent.mode, 'string');
      assert.ok(agent.mode.length > 0);
      assert.ok(Array.isArray(agent.read_first));
      assert.ok(agent.read_first.length > 0);
      assert.ok(Array.isArray(agent.allowed_paths));
      assert.ok(agent.allowed_paths.length > 0);
      assert.ok(Array.isArray(agent.forbidden_paths));
      assert.ok(agent.forbidden_paths.length > 0);
      assert.strictEqual(typeof agent.timeout_mins, 'number');
      assert.strictEqual(typeof agent.progress_timeout_mins, 'number');
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('writes bootstrap requirements and constraints into DECISIONS.md', () => {
    let project;
    try {
      project = createTempProject('bootstrap-decisions');

      run('node', [
        path.join(repoRoot(), 'scripts', 'bootstrap.js'),
        '--project', 'Durable contract project',
        '--requirements', 'Use streaming API,Support retries',
        '--constraints', 'No new dependencies,Node 18',
        '--coord', './coord',
      ], { cwd: project.root });

      const decisions = fs.readFileSync(path.join(project.root, 'coord', 'DECISIONS.md'), 'utf-8');
      const context = readJson(path.join(project.root, 'coord', 'context.json'));

      assert.deepStrictEqual(context.execution_topology, {
        execution_mode: '',
        reason: '',
        dependency_notes: [],
      });
      assert.ok(decisions.includes('## Durable Requirements'));
      assert.ok(decisions.includes('- Use streaming API'));
      assert.ok(decisions.includes('- Support retries'));
      assert.ok(decisions.includes('## Constraints'));
      assert.ok(decisions.includes('- No new dependencies'));
      assert.ok(decisions.includes('- Node 18'));
      assert.deepStrictEqual(context.requirements, ['Use streaming API', 'Support retries']);
      assert.deepStrictEqual(context.constraints, ['No new dependencies', 'Node 18']);
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});
