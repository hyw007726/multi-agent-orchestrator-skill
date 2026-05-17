'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  repoRoot,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  addKiloWorktree,
  spawnWorker,
  runLoop,
  waitFor,
  readJson,
  readJsonl,
} = require('./helpers/temp-project');

const fakeCliPath = path.join(repoRoot(), 'tests/helpers/fake-cli.js');

describe('MVP smoke test', () => {
  it('completes the full orchestrator pipeline end-to-end', async () => {
    let project;
    try {
      project = createTempProject();

      writeProjectConfig(project.root, fakeCliPath);
      bootstrapProject(project.root, 'Smoke test project');
      addKiloWorktree(project.root, 'agent-one');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-one': {
          description: 'Make the worker create worker-output.txt',
          cli: 'fake',
          allowed_paths: ['worker-output.txt'],
          forbidden_paths: ['coord/'],
          validation_command: ['test', '-f', 'worker-output.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n', 'utf-8');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Make the worker create worker-output.txt');

      spawnWorker(project.root, 'agent-one', promptFile, '[\"test\",\"-f\",\"worker-output.txt\"]');

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0, `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      await waitFor(() => {
        try {
          const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
          return agents && agents['agent-one'] && agents['agent-one'].status === 'completed';
        } catch {
          return false;
        }
      }, { timeoutMs: 5000 });

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.ok(agents && agents['agent-one'], 'agents.json should contain agent-one');
      assert.strictEqual(agents['agent-one'].status, 'completed');

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.ok(
        requests.some((r) => r.request_id === 'agent-one-req-smoke' && r.status === 'resolved'),
        'requests.jsonl should contain a resolved agent-one-req-smoke request'
      );

      const decisions = readJson(path.join(project.root, 'coord', 'decisions.json'));
      assert.ok(
        decisions.some((d) => d.request_id === 'agent-one-req-smoke'),
        'decisions.json should contain a decision for agent-one-req-smoke'
      );

      const decisionAudit = readJsonl(path.join(project.root, 'coord', 'decisions.jsonl'));
      assert.ok(
        decisionAudit.some((d) => d.request_id === 'agent-one-req-smoke'),
        'decisions.jsonl should contain an audit entry for agent-one-req-smoke'
      );

      const summary = fs.readFileSync(path.join(project.root, 'coord', 'review-summary.txt'), 'utf8');
      assert.ok(
        summary.includes('Fake worker agent-one has completed its smoke test task'),
        'review-summary.txt should contain the worker self-report'
      );
      assert.ok(summary.includes('No final AI summary call was run'));

      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf8');
      assert.ok(log.includes('Dashboard auto-launch disabled'));
      assert.ok(log.includes('Review terminal auto-launch disabled'));
      assert.ok(!log.includes('osascript'), 'log must not contain osascript');
      assert.ok(!log.includes('syntax error'), 'log must not contain syntax error');
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});
