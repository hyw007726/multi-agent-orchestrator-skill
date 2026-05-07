'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  createTempProject,
  bootstrapProject,
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

      assert.ok(example.tasks, 'should have tasks object');
      const agentNames = Object.keys(example.tasks);
      assert.strictEqual(agentNames.length, 1, 'should have exactly one agent entry');

      const agent = example.tasks[agentNames[0]];

      const requiredFields = [
        'description',
        'cli',
        'mode',
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
});
