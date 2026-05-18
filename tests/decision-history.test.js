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

describe('decision history', () => {
  it('preserves all approved decisions in the audit log while capping the recent window', () => {
    let project;
    try {
      project = createTempProject('decision-history-');

      const historyCliPath = path.join(project.root, 'history-cli.js');
      fs.writeFileSync(historyCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("history-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'function parseArrayBetween(startHeading, endHeading) {',
        '  const start = prompt.indexOf(startHeading);',
        '  const end = prompt.indexOf(endHeading);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  return match ? JSON.parse(match[0]) : [];',
        '}',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  const existingDecisions = parseArrayBetween("## Existing Decisions", "## Agent Worktree States");',
        '  if (existingDecisions.length > 30) {',
        '    console.error("Expected at most 30 existing decisions in arbitration prompt, got " + existingDecisions.length);',
        '    process.exit(2);',
        '  }',
        '  const requests = parseArrayBetween("## New Requests from Agents", "## Your Responsibilities");',
        '  const approved = requests.map((request) => ({',
        '    request_id: request.request_id,',
        '    decision: "Approved " + request.request_id,',
        '    reason: "Decision history test approval."',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions: [] }, null, 2));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Decision history summary complete.");',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "history",',
        '  orchestrator_cli: "history",',
        `  cli_templates: { history: 'node "${historyCliPath}" {prompt_file}' },`,
        '  cli_health_checks: { history: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Decision history test project');

      const seededDecisions = [];
      for (let i = 0; i < 35; i++) {
        seededDecisions.push({
          request_id: `seed-decision-${i}`,
          decision: `Seed decision ${i}`,
          reason: 'Preexisting decision used to verify prompt bounds.',
          resolved_at: new Date().toISOString(),
        });
      }
      fs.writeFileSync(
        path.join(project.root, 'coord', 'decisions.json'),
        JSON.stringify(seededDecisions, null, 2) + '\n',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(project.root, 'coord', 'decisions.jsonl'),
        seededDecisions.map((decision) => JSON.stringify(decision)).join('\n') + '\n',
        'utf-8',
      );

      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-history': {
          task: 'Decision history processing',
          status: 'completed',
          worktree: project.root,
          cli: 'history',
          base_ref: 'main',
        },
      }, null, 2) + '\n', 'utf-8');

      const requests = [];
      for (let i = 0; i < 35; i++) {
        requests.push({
          request_id: `agent-history-approve-${i}`,
          agent: 'agent-history',
          type: 'question',
          priority: 'medium',
          status: 'pending',
          content: `Approve decision ${i}`,
          created_at: new Date().toISOString(),
        });
      }
      fs.writeFileSync(
        path.join(project.root, 'coord', 'requests.jsonl'),
        requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
        'utf-8',
      );

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const recent = readJson(path.join(project.root, 'coord', 'decisions.json'));
      assert.strictEqual(recent.length, 30, 'decisions.json should keep only the recent window');
      assert.strictEqual(recent[0].request_id, 'agent-history-approve-5');
      assert.strictEqual(recent[recent.length - 1].request_id, 'agent-history-approve-34');

      const audit = readJsonl(path.join(project.root, 'coord', 'decisions.jsonl'));
      assert.strictEqual(audit.length, 70, 'decisions.jsonl should preserve seeded and newly approved decisions');
      for (const decision of [...seededDecisions, ...requests]) {
        assert.ok(
          audit.some((auditDecision) => auditDecision.request_id === decision.request_id),
          `Audit log missing ${decision.request_id}`,
        );
      }
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('records rejected high-priority requests in worker-visible decision history', () => {
    let project;
    try {
      project = createTempProject('decision-rejection-');

      const rejectCliPath = path.join(project.root, 'reject-cli.js');
      fs.writeFileSync(rejectCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("reject-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  console.log(JSON.stringify({',
        '    approved: [],',
        '    rejected: [{ request_id: "agent-history-high-reject", reason: "Rejected by regression test." }],',
        '    actions: []',
        '  }));',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "rejector",',
        '  orchestrator_cli: "rejector",',
        `  cli_templates: { rejector: ${JSON.stringify({ cmd: process.execPath, args: [rejectCliPath, { prompt_file: true }] })} },`,
        '  cli_health_checks: { rejector: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Rejected high-priority decision history test project');

      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-history': {
          task: 'Rejected high-priority request handling',
          status: 'completed',
          worktree: project.root,
          cli: 'rejector',
        },
      }, null, 2) + '\n', 'utf-8');

      fs.writeFileSync(
        path.join(project.root, 'coord', 'requests.jsonl'),
        JSON.stringify({
          request_id: 'agent-history-high-reject',
          agent: 'agent-history',
          type: 'question',
          priority: 'high',
          status: 'pending',
          content: 'High-priority request that should be rejected.',
          created_at: new Date().toISOString(),
        }) + '\n',
        'utf-8',
      );

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(
        requests.find((request) => request.request_id === 'agent-history-high-reject').status,
        'rejected',
      );

      const recent = readJson(path.join(project.root, 'coord', 'decisions.json'));
      const recentDecision = recent.find((decision) => decision.request_id === 'agent-history-high-reject');
      assert.ok(recentDecision, 'decisions.json should include the rejected high-priority request');
      assert.strictEqual(recentDecision.disposition, 'rejected');
      assert.strictEqual(recentDecision.decision, 'Request rejected');
      assert.strictEqual(recentDecision.reason, 'Rejected by regression test.');

      const audit = readJsonl(path.join(project.root, 'coord', 'decisions.jsonl'));
      const auditDecision = audit.find((decision) => decision.request_id === 'agent-history-high-reject');
      assert.ok(auditDecision, 'decisions.jsonl should include the rejected high-priority request');
      assert.strictEqual(auditDecision.disposition, 'rejected');
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('resolves duplicate pending request ids idempotently', () => {
    let project;
    try {
      project = createTempProject('decision-duplicate-request-');

      const duplicateCliPath = path.join(project.root, 'duplicate-cli.js');
      fs.writeFileSync(duplicateCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("duplicate-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  console.log(JSON.stringify({',
        '    approved: [{ request_id: "agent-duplicate-request", decision: "Duplicate approved.", reason: "Same request id should be idempotent." }],',
        '    rejected: [],',
        '    actions: []',
        '  }));',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "duplicate",',
        '  orchestrator_cli: "duplicate",',
        `  cli_templates: { duplicate: ${JSON.stringify({ cmd: process.execPath, args: [duplicateCliPath, { prompt_file: true }] })} },`,
        '  cli_health_checks: { duplicate: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'Duplicate request id regression test project');

      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-duplicate': {
          task: 'Duplicate request id handling',
          status: 'completed',
          worktree: project.root,
          cli: 'duplicate',
        },
      }, null, 2) + '\n', 'utf-8');

      fs.writeFileSync(
        path.join(project.root, 'coord', 'requests.jsonl'),
        [
          {
            request_id: 'agent-duplicate-request',
            agent: 'agent-duplicate',
            type: 'question',
            priority: 'medium',
            status: 'resolved',
            content: 'Earlier resolved copy.',
            created_at: new Date().toISOString(),
          },
          {
            request_id: 'agent-duplicate-request',
            agent: 'agent-duplicate',
            type: 'question',
            priority: 'medium',
            status: 'pending',
            content: 'Duplicate pending copy after the staging file was consumed.',
            created_at: new Date().toISOString(),
          },
        ].map((request) => JSON.stringify(request)).join('\n') + '\n',
        'utf-8',
      );

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.deepStrictEqual(
        requests.filter((request) => request.request_id === 'agent-duplicate-request').map((request) => request.status),
        ['resolved', 'resolved'],
      );

      const audit = readJsonl(path.join(project.root, 'coord', 'decisions.jsonl'));
      assert.strictEqual(
        audit.filter((decision) => decision.request_id === 'agent-duplicate-request').length,
        1,
        'duplicate pending entries should produce one new decision audit entry for the cycle',
      );
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });

  it('stamps run_id on decisions/events and filters prior-run decisions out of the arbitration prompt', () => {
    let project;
    try {
      project = createTempProject('decision-run-id-');

      const runIdCliPath = path.join(project.root, 'run-id-cli.js');
      // The fake CLI asserts that "## Existing Decisions" in the arbitration
      // prompt does NOT include the pre-seeded stale-run decision. If it does,
      // exit non-zero so the loop bubbles the failure up to the test.
      fs.writeFileSync(runIdCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("run-id-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  if (prompt.includes("stale-decision-from-prior-run")) {',
        '    console.error("Arbitration prompt leaked a prior-run decision");',
        '    process.exit(2);',
        '  }',
        '  console.log(JSON.stringify({',
        '    approved: [{ request_id: "agent-run-id-req", decision: "approved", reason: "ok" }],',
        '    rejected: [], actions: []',
        '  }));',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "runid",',
        '  orchestrator_cli: "runid",',
        `  cli_templates: { runid: ${JSON.stringify({ cmd: process.execPath, args: [runIdCliPath, { prompt_file: true }] })} },`,
        '  cli_health_checks: { runid: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 250,',
        '  poll_max_ms: 500,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'run_id stamping regression test project');

      // Pre-seed a decision from a prior run — it must NOT bleed into this run's
      // arbitration prompt (the fake CLI exits 2 if it does).
      const priorRunDecision = {
        request_id: 'stale-decision-from-prior-run',
        disposition: 'approved',
        decision: 'Stale approval from a previous run.',
        reason: 'Should not appear in this run.',
        resolved_at: new Date().toISOString(),
        run_id: 'run-from-a-previous-loop',
      };
      fs.writeFileSync(
        path.join(project.root, 'coord', 'decisions.json'),
        JSON.stringify([priorRunDecision], null, 2) + '\n',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(project.root, 'coord', 'decisions.jsonl'),
        JSON.stringify(priorRunDecision) + '\n',
        'utf-8',
      );

      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-run-id': {
          task: 'run_id stamping',
          status: 'completed',
          worktree: project.root,
          cli: 'runid',
        },
      }, null, 2) + '\n', 'utf-8');

      fs.writeFileSync(
        path.join(project.root, 'coord', 'requests.jsonl'),
        JSON.stringify({
          request_id: 'agent-run-id-req',
          agent: 'agent-run-id',
          type: 'question',
          priority: 'medium',
          status: 'pending',
          content: 'Trigger one arbitration cycle.',
          created_at: new Date().toISOString(),
        }) + '\n',
        'utf-8',
      );

      const loop = runLoop(project.root);
      assert.strictEqual(loop.status, 0,
        `orchestrator loop failed\nstdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`);

      const currentRun = readJson(path.join(project.root, 'coord', 'current_run.json'));
      assert.match(currentRun.run_id, /^run-/);
      const currentRunId = currentRun.run_id;
      assert.notStrictEqual(currentRunId, 'run-from-a-previous-loop');

      const audit = readJsonl(path.join(project.root, 'coord', 'decisions.jsonl'));
      const newDecision = audit.find((d) => d.request_id === 'agent-run-id-req');
      assert.ok(newDecision, 'new decision should be in the audit log');
      assert.strictEqual(newDecision.run_id, currentRunId, 'new decision should carry this run\'s run_id');

      const staleStillPersisted = audit.find((d) => d.request_id === 'stale-decision-from-prior-run');
      assert.ok(staleStillPersisted, 'audit log preserves the stale decision (history is append-only)');
      assert.strictEqual(staleStillPersisted.run_id, 'run-from-a-previous-loop');

      // Not every test scenario emits events (a single approved question may
      // trigger none), but every event that IS emitted must carry the run_id.
      const events = readJsonl(path.join(project.root, 'coord', 'events.jsonl'));
      for (const e of events) {
        assert.strictEqual(e.run_id, currentRunId, `event ${e.event} should carry run_id ${currentRunId}, got ${e.run_id}`);
      }
    } finally {
      if (project) {
        project.cleanup();
      }
    }
  });
});
