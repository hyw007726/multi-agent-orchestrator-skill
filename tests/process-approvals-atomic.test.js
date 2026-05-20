'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  createTempProject,
  bootstrapProject,
  runLoop,
  readJsonl,
} = require('./helpers/temp-project');

describe('processApprovals crash-atomicity', () => {
  // Fault model: the audit-log write fails after the request flip has landed.
  // With the new ordering (flip-then-audit), requests.jsonl must already show
  // 'resolved' — so on a real crash the next loop tick would not re-arbitrate.
  // With the old ordering (audit-then-flip), the audit write would have thrown
  // first, the flip never ran, and the request would stay 'pending' → next
  // tick double-arbitrates.
  //
  // We simulate the audit-write failure by replacing coord/decisions.jsonl with
  // a directory. fs.appendFileSync against a directory raises EISDIR, which is
  // caught by the loop's per-cycle try/catch.
  it('flips request status before the audit write, so a reboot does not re-decide it', () => {
    let project;
    try {
      project = createTempProject('approvals-atomic-');

      // Fake orchestrator CLI: approve any pending request, then echo a
      // benign payload for any other prompt mode.
      const fakeCliPath = path.join(project.root, 'approve-cli.js');
      const callCountPath = path.join(project.root, 'approve-cli-calls.json');
      fs.writeFileSync(fakeCliPath, [
        '#!/usr/bin/env node',
        "'use strict';",
        'const fs = require("fs");',
        `const callCountPath = ${JSON.stringify(callCountPath)};`,
        'function bumpArbitrationCalls() {',
        '  let current = { arbitration: 0 };',
        '  try { current = JSON.parse(fs.readFileSync(callCountPath, "utf-8")); } catch {}',
        '  current.arbitration = (current.arbitration || 0) + 1;',
        '  fs.writeFileSync(callCountPath, JSON.stringify(current), "utf-8");',
        '}',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") { console.log("approve-cli 1.0"); process.exit(0); }',
        'const prompt = fs.readFileSync(args[0], "utf-8");',
        'if (prompt.includes("system orchestrator for a multi-agent project")) {',
        '  bumpArbitrationCalls();',
        '  const start = prompt.indexOf("## New Requests from Agents");',
        '  const end = prompt.indexOf("## Your Responsibilities", start + 1);',
        '  const section = prompt.slice(start, end === -1 ? undefined : end);',
        '  const match = section.match(/\\[[\\s\\S]*\\]/);',
        '  const requests = match ? JSON.parse(match[0]) : [];',
        '  const approved = requests.map(r => ({',
        '    request_id: r.request_id,',
        '    decision: "Approved " + r.request_id,',
        '    reason: "Atomicity test approval."',
        '  }));',
        '  console.log(JSON.stringify({ approved, rejected: [], actions: [] }, null, 2));',
        '  process.exit(0);',
        '}',
        'if (prompt.includes("reviewing the completed output")) {',
        '  console.log("Atomicity test summary.");',
        '  process.exit(0);',
        '}',
        'process.exit(0);',
      ].join('\n'), 'utf-8');

      fs.writeFileSync(path.join(project.root, 'orchestrator.config.js'), [
        'module.exports = {',
        '  default_cli: "approve",',
        '  orchestrator_cli: "approve",',
        `  cli_templates: { approve: 'node "${fakeCliPath}" {prompt_file}' },`,
        '  cli_health_checks: { approve: "node -e \\"process.exit(0)\\"" },',
        '  poll_min_ms: 200,',
        '  poll_max_ms: 400,',
        '  launch_dashboard: false,',
        '  launch_review_terminal: false,',
        '};',
      ].join('\n') + '\n', 'utf-8');

      bootstrapProject(project.root, 'processApprovals atomicity test');

      // Seed agents.json with one already-completed agent so the loop's
      // "all done" check fires after the approval cycle.
      fs.writeFileSync(path.join(project.root, 'coord', 'agents.json'), JSON.stringify({
        'agent-atomic': {
          task: 'Atomicity test',
          status: 'completed',
          worktree: project.root,
          cli: 'approve',
          base_ref: 'main',
        },
      }, null, 2) + '\n', 'utf-8');

      // Seed one pending request whose approval the loop will attempt to record.
      const pendingRequest = {
        request_id: 'agent-atomic-approve-1',
        agent: 'agent-atomic',
        type: 'question',
        priority: 'medium',
        status: 'pending',
        content: 'Approve me.',
        created_at: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(project.root, 'coord', 'requests.jsonl'),
        JSON.stringify(pendingRequest) + '\n',
        'utf-8',
      );

      // Replace decisions.jsonl with a directory of the same name. The
      // bootstrap step created it as an empty file; rm + mkdir gives us the
      // fault we want without touching any other coord state.
      const auditPath = path.join(project.root, 'coord', 'decisions.jsonl');
      fs.rmSync(auditPath, { force: true });
      fs.mkdirSync(auditPath);

      // Run the loop. The loop will: arbitrate (approves), flip requests.jsonl
      // (success), then try appendJSONL on the audit dir (EISDIR → caught).
      // On the next tick there are no pending requests, the agent is already
      // completed, and the "all done" check exits the loop with status 0.
      const loop = runLoop(project.root);

      // The loop is allowed to exit 0 or to time out (depends on how fast it
      // notices all-done after the failed cycle). What matters is the file state.
      const requests = readJsonl(path.join(project.root, 'coord', 'requests.jsonl'));
      assert.strictEqual(requests.length, 1, 'request entry preserved');
      assert.strictEqual(
        requests[0].status,
        'resolved',
        `request must be flipped to 'resolved' before the audit write; loop stdout:\n${loop.stdout}\nstderr:\n${loop.stderr}`,
      );

      // decisions.jsonl is still a directory — confirming the audit append did
      // fail. This is what makes the test meaningful: we know the flip ran
      // even though the audit step blew up.
      assert.ok(fs.statSync(auditPath).isDirectory(), 'decisions.jsonl audit path remained a directory (audit write failed)');
      assert.strictEqual(JSON.parse(fs.readFileSync(callCountPath, 'utf-8')).arbitration, 1,
        'first boot should arbitrate the pending request exactly once');

      // Reboot the loop against the same coord state. The request has already
      // been flipped out of "pending", so even with the failed audit path still
      // present the loop must not ask the orchestrator CLI to decide it again.
      const reboot = runLoop(project.root);
      assert.strictEqual(reboot.status, 0,
        `orchestrator reboot failed\nstdout:\n${reboot.stdout}\nstderr:\n${reboot.stderr}`);
      assert.strictEqual(JSON.parse(fs.readFileSync(callCountPath, 'utf-8')).arbitration, 1,
        'reboot must not re-arbitrate a request whose status flip already landed');
    } finally {
      if (project) project.cleanup();
    }
  });
});
