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
});
