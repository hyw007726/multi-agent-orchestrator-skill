'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('child_process');

const {
  repoRoot,
  createTempProject,
  bootstrapProject,
  addKiloWorktree,
  runLoop,
  readJson,
} = require('./helpers/temp-project');

describe('restart contract preservation', () => {
  it('preserves the full worker and agents.json contracts across a hard restart', () => {
    let project;
    try {
      project = createTempProject('restart-contract-');

      const contractCliPath = path.join(project.root, 'contract-cli.js');
      fs.writeFileSync(contractCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const promptFile = process.argv[2];',
        'const prompt = fs.readFileSync(promptFile, "utf-8");',
        'const agentName = "agent-contract";',
        '',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        '',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  if (!prompt.includes("## Durable Project Decisions") || !prompt.includes("Restart contract preservation test project")) {',
        '    console.error("orchestrator prompt lost DECISIONS.md context");',
        '    process.exit(1);',
        '  }',
        '  if (!prompt.includes("## Caller Session Context") || !prompt.includes("Restart caller nuance survives arbitration")) {',
        '    console.error("orchestrator prompt lost CALLER_CONTEXT.md context");',
        '    process.exit(1);',
        '  }',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map((request) => ({',
        '    request_id: request.request_id,',
        '    decision: "Approved " + request.request_id,',
        '    reason: "Contract preservation test approval."',
        '  }));',
        '  const actions = requests.map((request) => request.request_id.includes("restart")',
        '    ? { type: "hard_restart", agent: request.agent, instruction: "Continue after hard restart." }',
        '    : { type: "end_agent", agent: request.agent }',
        '  );',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        '',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Contract summary complete.");',
        '  process.exit(0);',
        '}',
        '',
        'const restarted = prompt.includes("Restart Instruction");',
        'const hasFullContract = prompt.includes("Worker Agent Prompt Template")',
        '  && prompt.includes("ALLOWED PATHS")',
        '  && prompt.includes("src/index.js")',
        '  && prompt.includes("src/**")',
        '  && prompt.includes("package.json")',
        '  && prompt.includes("Restart caller nuance survives restart")',
        '  && prompt.includes("\\"agent\\": \\"agent-contract\\"")',
        '  && prompt.includes("Continue after hard restart.");',
        'if (restarted && hasFullContract) {',
        '  fs.writeFileSync("restart-success.txt", "ok\\n", "utf-8");',
        '} else if (restarted) {',
        '  fs.writeFileSync("missing-restart-contract.txt", "restart prompt lost the worker contract\\n", "utf-8");',
        '} else {',
        '  fs.writeFileSync("needs-recovery.txt", "recover me\\n", "utf-8");',
        '}',
        '',
        'stageRequest({',
        '  request_id: restarted ? "agent-contract-done" : "agent-contract-restart",',
        '  agent: agentName,',
        '  type: "review_request",',
        '  priority: "medium",',
        '  status: "pending",',
        '  content: restarted ? "Ready for validation." : "Please hard restart me.",',
        '  created_at: new Date().toISOString()',
        '});',
        '',
        'const maxTimer = setTimeout(() => process.exit(0), 50);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n') + '\n', 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "contract",',
        '  orchestrator_cli: "contract",',
        `  cli_templates: { contract: 'node "${contractCliPath}" {prompt_file}' },`,
        '  cli_health_checks: { contract: "node -e \\"process.exit(0)\\"" },',
        '  default_max_restarts: 2,',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Restart contract preservation test project');
      fs.writeFileSync(path.join(project.root, 'coord', 'CALLER_CONTEXT.md'), [
        '# Caller Context',
        '',
        '- Restart caller nuance survives arbitration',
        '- Restart caller nuance survives restart',
        '',
      ].join('\n'), 'utf-8');
      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-contract': {
          description: 'Verify restarts preserve the worker contract.',
          cli: 'contract',
          mode: 'auto',
          read_first: ['src/index.js'],
          allowed_paths: ['src/**', 'restart-success.txt'],
          forbidden_paths: ['package.json'],
          validation_command: ['test', '-f', 'restart-success.txt'],
          timeout_mins: 7,
          progress_timeout_mins: 9,
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n', 'utf-8');
      addKiloWorktree(project.root, 'agent-contract');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Initial contract run.', 'utf-8');

      const spawnResult = spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-contract',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'contract',
        '--validate', '["test","-f","restart-success.txt"]',
        '--timeout', '7',
        '--progress-timeout', '9',
        '--base-ref', 'main',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent.js failed: ${spawnResult.stderr}`);

      const initialAgents = readJson(path.join(project.root, 'coord', 'agents.json'));
      const initialStartedAt = initialAgents['agent-contract'].started_at;
      const initialCurrentStartedAt = initialAgents['agent-contract'].current_started_at;

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      const agent = agents['agent-contract'];
      const log = fs.readFileSync(path.join(project.root, 'coord', 'orchestrator.log'), 'utf-8');
      assert.ok(agent, 'agents.json should contain agent-contract');
      assert.strictEqual(agent.status, 'completed',
        `agent-contract should complete after restart\nagent:\n${JSON.stringify(agent, null, 2)}\nlog:\n${log}`);
      assert.strictEqual(agent.task, 'Continue after hard restart.');
      assert.strictEqual(agent.restart_count, 1);
      assert.strictEqual(agent.started_at, initialStartedAt);
      assert.ok(agent.current_started_at, 'current_started_at should be recorded');
      assert.notStrictEqual(agent.current_started_at, initialStartedAt,
        'current process start should refresh after respawn while lifecycle start is preserved');
      assert.notStrictEqual(agent.current_started_at, initialCurrentStartedAt,
        'current process start should change on respawn');
      assert.strictEqual(agent.last_spawned_at, agent.current_started_at);
      assert.deepStrictEqual(agent.validate_cmd, ['test', '-f', 'restart-success.txt']);
      assert.strictEqual(agent.timeout_mins, 7);
      assert.strictEqual(agent.progress_timeout_mins, 9);
      assert.strictEqual(agent.base_ref, 'main');
      assert.match(agent.recovery_tag, /^recovery\/agent-contract\//);

      assert.ok(log.includes('Running validation: test -f restart-success.txt'),
        'validation should still run after the restart');
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});
