'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  repoRoot,
  createTempProject,
  bootstrapProject,
  addKiloWorktree,
  runLoop,
  readJson,
  readJsonl,
} = require('./helpers/temp-project');

describe('staging write', () => {
  it('worker that stages a review_request then exits is NOT marked exited', async () => {
    let project;
    try {
      project = createTempProject('staging-vanish-');

      // CLI that writes a review_request to staging (via .tmp → .json) and exits
      // immediately, simulating a worker that completed its work but whose process
      // vanishes before the loop's liveness check.
      const stageExitCliPath = path.join(project.root, 'stage-exit-cli.js');
      fs.writeFileSync(stageExitCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("stage-exit-cli 1.0"); process.exit(0); }',
        'const promptFile = args[0];',
        'if (!promptFile) { console.error("Error: prompt file required"); process.exit(1); }',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        '',
        '// Handle orchestrator arbitration prompt (when used as orchestrator_cli).',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const requestsStart = prompt.indexOf("## New Requests from Agents");',
        '  const requestsSection = requestsStart !== -1 ? prompt.slice(requestsStart) : prompt;',
        '  const requestIdMatch = requestsSection.match(/"request_id":\\s*"([^"]+)"/);',
        '  const requestId = requestIdMatch ? requestIdMatch[1] : "unknown-req";',
        '  const agentSearchStart = requestIdMatch ? requestsSection.indexOf(requestIdMatch[0]) : 0;',
        '  const remaining = requestsSection.slice(agentSearchStart);',
        '  const agentMatch = remaining.match(/"agent":\\s*"([^"]+)"/);',
        '  const agentName = agentMatch ? agentMatch[1] : "unknown-agent";',
        '  const response = {',
        '    approved: [{',
        '      request_id: requestId,',
        '      decision: "Staging-test completion approved.",',
        '      reason: "Fake orchestrator approved the staging review request."',
        '    }],',
        '    rejected: [],',
        '    actions: [{ type: "end_agent", agent: agentName }],',
        '  };',
        '  console.log(JSON.stringify(response, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        '// Handle final review summary prompt.',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Staging review summary: completed.");',
        '  process.exit(0);',
        '}',
        '',
        'let agentName = "agent-stage";',
        'const m = prompt.match(/"agent":\\s*"([^"]+)"/);',
        'if (m && m[1] && m[1] !== "string — name of agent") agentName = m[1];',
        '',
        'const request = {',
        '  request_id: agentName + "-req-staging",',
        '  agent: agentName,',
        '  type: "review_request",',
        '  priority: "medium",',
        '  status: "pending",',
        '  content: "Fake worker " + agentName + " completed via staging write.",',
        '  created_at: new Date().toISOString(),',
        '};',
        '',
        'const requestsDir = path.join("coord", "requests");',
        'fs.mkdirSync(requestsDir, { recursive: true });',
        'const ts = Date.now();',
        'const tmpFile = path.join(requestsDir, agentName + "-" + ts + ".tmp");',
        'const finalFile = path.join(requestsDir, agentName + "-" + ts + ".json");',
        'fs.writeFileSync(tmpFile, JSON.stringify(request), "utf-8");',
        'fs.renameSync(tmpFile, finalFile);',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      // Config: stageexit CLI handles all roles (worker, orchestrator, summary).
      const configPath = path.join(project.root, 'orchestrator.config.js');
      fs.writeFileSync(configPath, [
        'module.exports = {',
        '  default_cli: "stageexit",',
        '  orchestrator_cli: "stageexit",',
        `  cli_templates: { stageexit: 'node "${stageExitCliPath}" {prompt_file}' },`,
        '  cli_health_checks: { stageexit: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Staging write test project');

      // Write context with a task.
      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
      context.tasks = {
        'agent-stage': {
          description: 'Write a review to staging dir, then exit.',
          cli: 'stageexit',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));

      addKiloWorktree(project.root, 'agent-stage');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Write a review_request to coord/requests/ and exit.');

      const { spawnSync } = require('child_process');
      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-stage',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'stageexit',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      // Run the loop — the staged request should be found before marking "exited".
      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.ok(agents && agents['agent-stage'], 'agents.json should contain agent-stage');
      assert.notStrictEqual(agents['agent-stage'].status, 'exited',
        `Worker should NOT be "exited" when staged review_request exists. Got: ${agents['agent-stage'].status}`);

      // The request should be in requests.jsonl and resolved.
      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      const ours = requests.filter(r => r.request_id === 'agent-stage-req-staging');
      assert.ok(ours.length > 0, 'requests.jsonl should contain the staged review_request');
      assert.strictEqual(ours[0].status, 'resolved',
        'Staged request should be resolved by the orchestrator');

      // No .json files left in staging.
      const requestsDir = path.join(project.root, 'coord', 'requests');
      if (fs.existsSync(requestsDir)) {
        const remaining = fs.readdirSync(requestsDir).filter(f => f.endsWith('.json'));
        assert.strictEqual(remaining.length, 0,
          `No .json files should remain in staging, found: ${remaining.join(', ')}`);
      }
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('consolidates staged requests without drops and resolves/rejects them', async () => {
    let project;
    try {
      project = createTempProject('staging-lifecycle-');

      const resolverCliPath = path.join(project.root, 'resolver-cli.js');
      fs.writeFileSync(resolverCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("resolver-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities");',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.filter(r => r.request_id.includes("approve")).map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Lifecycle test approval."',
        '  }));',
        '  const rejected = requests.filter(r => r.request_id.includes("reject")).map(r => ({',
        '    request_id: r.request_id,',
        '    reason: "Lifecycle test rejection."',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected, actions: [] }, null, 2));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Lifecycle summary complete.");',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "resolver",',
        '  orchestrator_cli: "resolver",',
        `  cli_templates: { resolver: 'node "${resolverCliPath}" {prompt_file}' },`,
        '  cli_health_checks: { resolver: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Staged request lifecycle test project');

      const agentsPath = path.join(project.root, 'coord', 'agents.json');
      fs.writeFileSync(agentsPath, JSON.stringify({
        'agent-lifecycle': {
          task: 'Lifecycle request processing',
          status: 'completed',
          worktree: project.root,
          cli: 'resolver',
          base_ref: 'main',
        },
      }, null, 2) + '\n', 'utf-8');

      const requestsDir = path.join(project.root, 'coord', 'requests');
      const stagedRequests = [];
      for (let i = 0; i < 12; i++) {
        const disposition = i % 2 === 0 ? 'approve' : 'reject';
        stagedRequests.push({
          request_id: `agent-lifecycle-${disposition}-${i}`,
          agent: 'agent-lifecycle',
          type: i % 3 === 0 ? 'change' : 'question',
          priority: 'medium',
          status: 'pending',
          content: `Lifecycle request ${i}`,
          created_at: new Date().toISOString(),
        });
      }

      for (const request of stagedRequests) {
        const tmpFile = path.join(requestsDir, `${request.request_id}.tmp`);
        const finalFile = path.join(requestsDir, `${request.request_id}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify(request), 'utf-8');
        fs.renameSync(tmpFile, finalFile);
      }

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      const byId = new Map(requests.map((r) => [r.request_id, r]));
      for (const request of stagedRequests) {
        assert.ok(byId.has(request.request_id), `Missing staged request ${request.request_id}`);
        const expectedStatus = request.request_id.includes('approve') ? 'resolved' : 'rejected';
        assert.strictEqual(byId.get(request.request_id).status, expectedStatus,
          `${request.request_id} should be ${expectedStatus}`);
      }

      const remaining = fs.readdirSync(requestsDir).filter(f => f.endsWith('.json'));
      assert.strictEqual(remaining.length, 0,
        `No staged .json files should remain, found: ${remaining.join(', ')}`);
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});
