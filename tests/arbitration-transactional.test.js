'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  createTempProject,
  bootstrapProject,
  runLoop,
  readJson,
  readJsonl,
} = require('./helpers/temp-project');

describe('arbitration transactional validation', () => {
  // Fault model: the orchestrator CLI returns end_agent for an agent without
  // approving the request that prompted it. Pre-validation, the loop would
  // have killed the worker AND left the review_request pending — a half-applied
  // cycle whose intent is invisible from the on-disk audit. With validation,
  // the response is rejected up front; no kill, no resolution, the next tick
  // will re-render the prompt with the same pending request.
  it('rejects an arbitration response that issues end_agent without approving the agent\'s request', () => {
    let project;
    try {
      project = createTempProject('arbitration-txn-');

      const fakeCliPath = path.join(project.root, 'malformed-cli.js');
      fs.writeFileSync(fakeCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("malformed-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  // Malformed: an end_agent action without ANY approved/rejected entries.',
        '  const actions = requests.map((r) => ({ type: "end_agent", agent: r.agent }));',
        '  console.log(JSON.stringify({ approved: [], rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("(unused)");',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "malformed",',
        '  orchestrator_cli: "malformed",',
        `  cli_templates: { malformed: 'node "${fakeCliPath}" {prompt_file}' },`,
        '  cli_health_checks: { malformed: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 200,',
        '  poll_max_ms: 400,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Arbitration transactional test');

      // Seed a single review_request and a "running" agent record. The loop's
      // arbitration cycle will see the pending request, the fake CLI will return
      // a malformed envelope, and validation must reject it before any side
      // effects land.
      const fakePid = 999_999_999; // Definitely not running.
      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-malformed': {
          task: 'Transactional arbitration test',
          status: 'running',
          worktree: project.root,
          cli: 'malformed',
          pid: fakePid,
          base_ref: 'main',
          spawned_cmdline: 'node /fake/cli/that/never/existed',
          process_match: 'node-that-never-existed',
          current_started_at: new Date().toISOString(),
        },
      }, null, 2) + '\n', 'utf-8');
      const pendingRequest = {
        request_id: 'agent-malformed-req-1',
        agent: 'agent-malformed',
        type: 'review_request',
        priority: 'medium',
        status: 'pending',
        content: 'Please end me.',
        created_at: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(project.root, 'coord', 'requests.jsonl'),
        JSON.stringify(pendingRequest) + '\n',
        'utf-8',
      );

      // The loop will hit the missing-process branch on its first tick (pid 999_999_999
      // doesn't exist), but with a pending review_request it will wait for arbitration.
      // Arbitration returns the malformed envelope → validation rejects it → no side
      // effects, request stays pending. After the test's 10-second timeout we inspect.
      runLoop(project.root);

      // 1. Request is still pending — no decision was recorded.
      const requestsAfter = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requestsAfter.length, 1);
      assert.strictEqual(requestsAfter[0].status, 'pending',
        'malformed response must not flip request status');

      // 2. No decisions audit entry was appended.
      const decisions = readJsonl(path.join(project.root, 'coord', 'decisions.jsonl'));
      assert.strictEqual(decisions.length, 0, 'no decision should be recorded for the rejected response');

      // 3. Agent stayed in 'running' (no end_agent, no parking from this path).
      const agents = readJson(path.join(project.root, 'coord', 'agents.json'));
      assert.strictEqual(agents['agent-malformed'].status, 'running',
        'malformed response must not transition the agent away from running');

      // 4. events.jsonl has at least one arbitration_response_rejected row.
      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const rejectedEvents = events.filter((e) => e.event === 'arbitration_response_rejected');
      assert.ok(rejectedEvents.length >= 1,
        `expected at least one arbitration_response_rejected event, got events:\n${JSON.stringify(events, null, 2)}`);
      assert.match(
        rejectedEvents[0].data.reasons.join(' '),
        /agent-malformed/,
        'rejected-event reasons must name the offending agent',
      );
    } finally {
      if (project) project.cleanup();
    }
  });

  // Fault model: an LLM-generated arbitration envelope simulates a crash by
  // skipping the request resolution but still asking for a soft_restart. The
  // pre-kill audit row in events.jsonl is the *only* surface that proves the
  // orchestrator's intent — agents.json alone would just show restart_count++
  // with no narrative. We assert restart_scheduled is appended BEFORE the
  // kill+respawn path runs.
  it('persists restart_scheduled to events.jsonl before respawning the worker', () => {
    let project;
    try {
      project = createTempProject('restart-intent-');

      const fakeCliPath = path.join(project.root, 'restart-cli.js');
      // Worker / orchestrator CLI logic in a single file. Worker mode stages a
      // review_request then sleeps. Orchestrator mode approves + soft_restarts.
      fs.writeFileSync(fakeCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const path = require("path");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("restart-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map((r) => ({',
        '    request_id: r.request_id, decision: "approved", reason: "restart intent test"',
        '  }));',
        '  const actions = requests.map((r) => ({',
        '    type: "soft_restart", agent: r.agent, instruction: "go again"',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions }, null, 2));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Restart intent test summary.");',
        '  process.exit(0);',
        '}',
        'const agentName = "agent-restart";',
        'function stageRequest(request) {',
        '  const requestsDir = path.join("coord", "requests");',
        '  fs.mkdirSync(requestsDir, { recursive: true });',
        '  const tmpFile = path.join(requestsDir, request.request_id + ".tmp");',
        '  const finalFile = path.join(requestsDir, request.request_id + ".json");',
        '  fs.writeFileSync(tmpFile, JSON.stringify(request) + "\\n", "utf-8");',
        '  fs.renameSync(tmpFile, finalFile);',
        '}',
        'stageRequest({',
        '  request_id: agentName + "-restart-me-" + Date.now(),',
        '  agent: agentName,',
        '  type: "review_request",',
        '  priority: "medium",',
        '  status: "pending",',
        '  content: "Ready for review",',
        '  created_at: new Date().toISOString(),',
        '});',
        '// Stay alive so the orchestrator has a process to SIGTERM, then exit.',
        'const maxTimer = setTimeout(() => process.exit(0), 60_000);',
        'process.on("SIGTERM", () => { clearTimeout(maxTimer); process.exit(0); });',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "restart",',
        '  orchestrator_cli: "restart",',
        `  cli_templates: { restart: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fakeCliPath)}, { prompt_file: true }] } },`,
        '  cli_health_checks: { restart: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 200,',
        '  poll_max_ms: 400,',
        '  default_max_restarts: 1,', // first restart_scheduled is enough; second exhausts budget
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Restart intent persistence test');

      const contextPath = path.join(project.root, 'coord', 'context.json');
      const context = readJson(contextPath);
      context.tasks = {
        'agent-restart': {
          description: 'Restart intent persistence agent.',
          cli: 'restart',
          allowed_paths: ['*.txt'],
        },
      };
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

      const { addKiloWorktree, repoRoot } = require('./helpers/temp-project');
      addKiloWorktree(project.root, 'agent-restart');

      const promptFile = path.join(project.root, 'worker-prompt.txt');
      fs.writeFileSync(promptFile, 'Start the restart-intent agent.', 'utf-8');
      const spawnResult = require('child_process').spawnSync('node', [
        path.join(repoRoot(), 'scripts', 'spawn-agent.js'),
        '--agent', 'agent-restart',
        '--prompt-file', promptFile,
        '--coord', './coord',
        '--cli', 'restart',
      ], { cwd: project.root, encoding: 'utf-8' });
      assert.strictEqual(spawnResult.status, 0, `spawn-agent failed: ${spawnResult.stderr}`);

      runLoop(project.root);

      // Find the first restart_scheduled event for our agent.
      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      const restartEvents = events.filter(
        (e) => e.event === 'restart_scheduled' && e.agent === 'agent-restart',
      );
      assert.ok(restartEvents.length >= 1, `expected at least one restart_scheduled event, got:\n${JSON.stringify(events, null, 2)}`);
      // restart_scheduled must record which requests were tied to the action.
      assert.ok(
        Array.isArray(restartEvents[0].data?.request_ids) && restartEvents[0].data.request_ids.length >= 1,
        `restart_scheduled must include resolved request_ids; got data=${JSON.stringify(restartEvents[0].data)}`,
      );

      // Crucial ordering check: restart_scheduled must come before
      // signal_sent for this agent (the actual kill). That proves intent was
      // persisted to events.jsonl BEFORE the irreversible side effect.
      const intentTs = restartEvents[0].timestamp;
      const killEvents = events.filter(
        (e) => e.event === 'signal_sent' && e.agent === 'agent-restart',
      );
      if (killEvents.length > 0) {
        assert.ok(
          intentTs <= killEvents[0].timestamp,
          `restart_scheduled (${intentTs}) must precede signal_sent (${killEvents[0].timestamp})`,
        );
      }
    } finally {
      if (project) project.cleanup();
    }
  });
});
