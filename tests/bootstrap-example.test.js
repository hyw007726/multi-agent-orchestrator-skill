'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const {
  createTempProject,
  bootstrapProject,
  repoRoot,
  run,
  readJson,
} = require('./helpers/temp-project');

describe('bootstrap example file', () => {
  it('refuses to overwrite existing coord state unless --force is provided', () => {
    let project;
    try {
      project = createTempProject('bootstrap-existing');
      const bootstrapScript = path.join(repoRoot(), 'scripts', 'bootstrap.js');
      run('node', [
        bootstrapScript,
        '--project', 'Original project',
        '--coord', './coord',
      ], { cwd: project.root });

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const decisionsPath = path.join(project.root, 'coord', 'DECISIONS.md');
      const staleRequestPath = path.join(project.root, 'coord', 'requests', 'stale.json');
      const staleProgressPath = path.join(project.root, 'coord', 'progress', 'agent.json');
      fs.writeFileSync(decisionsPath, '# Architectural Decisions\n\n- Preserve this manual decision.\n', 'utf-8');
      fs.writeFileSync(staleRequestPath, '{"request_id":"stale"}\n', 'utf-8');
      fs.writeFileSync(staleProgressPath, '{"phase":"stale"}\n', 'utf-8');

      const blocked = spawnSync(process.execPath, [
        bootstrapScript,
        '--project', 'Overwriting project',
        '--coord', './coord',
      ], {
        cwd: project.root,
        encoding: 'utf-8',
      });

      assert.notStrictEqual(blocked.status, 0);
      assert.match(blocked.stderr, /already contains coordination state/);
      assert.match(blocked.stderr, /context\.json/);
      assert.match(blocked.stderr, /DECISIONS\.md/);
      assert.match(blocked.stderr, /requests\//);
      assert.match(blocked.stderr, /progress\//);
      assert.strictEqual(readJson(contextPath).project, 'Original project');
      assert.match(fs.readFileSync(decisionsPath, 'utf-8'), /Preserve this manual decision/);
      assert.ok(fs.existsSync(staleRequestPath));
      assert.ok(fs.existsSync(staleProgressPath));

      const forced = spawnSync(process.execPath, [
        bootstrapScript,
        '--project', 'Forced project',
        '--coord', './coord',
        '--force',
      ], {
        cwd: project.root,
        encoding: 'utf-8',
      });

      assert.strictEqual(forced.status, 0, forced.stderr);
      assert.strictEqual(readJson(contextPath).project, 'Forced project');
      assert.doesNotMatch(fs.readFileSync(decisionsPath, 'utf-8'), /Preserve this manual decision/);
      assert.ok(!fs.existsSync(staleRequestPath));
      assert.ok(!fs.existsSync(staleProgressPath));
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

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

      const callerContext = fs.readFileSync(path.join(project.root, 'coord', 'CALLER_CONTEXT.md'), 'utf-8');
      assert.ok(callerContext.includes('# Caller Context'));
      assert.ok(callerContext.includes('## User Intent'));
      assert.ok(callerContext.includes('- Durable contract project'));
      assert.ok(callerContext.includes('## Compact Inputs'));
      assert.ok(callerContext.includes('- Use streaming API'));
      assert.ok(callerContext.includes('- Node 18'));
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});
