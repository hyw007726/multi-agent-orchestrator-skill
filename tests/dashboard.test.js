'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { repoRoot, waitFor, cleanupProcess } = require('./helpers/temp-project');

const dashboardPath = path.join(repoRoot(), 'scripts', 'dashboard.js');

describe('dashboard CLI', () => {
  it('renders stalled state, agent summaries, pending requests, and recent decisions', async () => {
    const coord = makeCoord('dashboard-render-');
    let child;
    try {
      fs.writeFileSync(path.join(coord, 'orchestrator-stalled.flag'), JSON.stringify({
        message: 'Arbitrator unavailable.',
        pending_requests: 2,
        high_priority_requests: 1,
        timestamp: '2026-05-08T00:00:00.000Z',
      }), 'utf-8');

      fs.writeFileSync(path.join(coord, 'agents.json'), JSON.stringify({
        'agent-running': {
          status: 'running',
          task: 'Implement dashboard rendering with enough detail to truncate',
          cli: 'fake',
          pid: 12345,
          restart_count: 2,
        },
        'agent-errored': {
          status: 'errored',
          task: 'Investigate failure',
          pid: 23456,
        },
        'agent-exited': {
          status: 'exited',
          task: 'Worker vanished',
          pid: 34567,
          exit_log_tail: 'line one\nvanished tail\n',
        },
      }, null, 2), 'utf-8');
      fs.writeFileSync(path.join(coord, 'logs', 'agent-running.log'), [
        'Starting work',
        'Tool Use: read_file README.md',
        'Editing file: src/app.js',
      ].join('\n') + '\n', 'utf-8');
      fs.writeFileSync(path.join(coord, 'logs', 'agent-errored.log'), 'build failed\n', 'utf-8');
      fs.writeFileSync(path.join(coord, 'logs', 'agent-exited.log'), 'process ended\n', 'utf-8');
      fs.writeFileSync(path.join(coord, 'requests.jsonl'), [
        JSON.stringify({
          request_id: 'req-pending',
          agent: 'agent-running',
          type: 'review_request',
          priority: 'high',
          status: 'pending',
        }),
        JSON.stringify({
          request_id: 'req-resolved',
          agent: 'agent-running',
          type: 'review_request',
          priority: 'low',
          status: 'resolved',
        }),
      ].join('\n') + '\n', 'utf-8');
      fs.writeFileSync(path.join(coord, 'decisions.json'), JSON.stringify([
        decision('dec-1'),
        decision('dec-2'),
        decision('dec-3'),
        decision('dec-4'),
        decision('dec-5'),
        decision('dec-6'),
      ], null, 2), 'utf-8');

      child = startDashboard(coord);
      const output = await waitForOutput(
        child,
        (text) => text.includes('req-pending') && text.includes('dec-6'),
      );

      assert.match(output, /ORCHESTRATOR CLI STALLED/);
      assert.match(output, /Arbitrator unavailable/);
      assert.match(output, /High-priority blocked: 1/);
      assert.match(output, /agent-running/);
      assert.match(output, /Editing: src\/app\.js/);
      assert.match(output, /ERROR: build failed/);
      assert.match(output, /VANISHED: vanished tail/);
      assert.match(output, /req-pending/);
      assert.doesNotMatch(output, /req-resolved/);
      assert.match(output, /dec-6/);

      child.kill('SIGTERM');
      const closed = await waitForClose(child);
      assert.strictEqual(closed.code, 0);
      assert.match(closed.output, /Dashboard closed \(SIGTERM\)/);
      assert.strictEqual(fs.existsSync(path.join(coord, 'abort.flag')), false);
    } finally {
      cleanupProcess(child);
      fs.rmSync(coord, { recursive: true, force: true });
    }
  });

  it('requires Ctrl+C confirmation before writing the abort flag', async () => {
    const coord = makeCoord('dashboard-sigint-');
    let child;
    try {
      child = startDashboard(coord);
      await waitForOutput(child, (text) => text.includes('ORCHESTRATOR DASHBOARD'));
      child.kill('SIGINT');
      await waitForOutput(child, (text) => text.includes('Abort all running agents?'));
      child.stdin.write('n\n');
      let closed = await waitForClose(child);

      assert.strictEqual(closed.code, 0);
      assert.match(closed.output, /Abort cancelled/);
      assert.strictEqual(fs.existsSync(path.join(coord, 'abort.flag')), false);

      child = startDashboard(coord);
      await waitForOutput(child, (text) => text.includes('ORCHESTRATOR DASHBOARD'));
      child.kill('SIGINT');
      await waitForOutput(child, (text) => text.includes('Abort all running agents?'));
      child.stdin.write('y\n');
      closed = await waitForClose(child);

      assert.strictEqual(closed.code, 0);
      assert.match(closed.output, /Abort flag written/);
      assert.strictEqual(fs.readFileSync(path.join(coord, 'abort.flag'), 'utf-8'), 'true');
    } finally {
      cleanupProcess(child);
      fs.rmSync(coord, { recursive: true, force: true });
    }
  });
});

function makeCoord(prefix) {
  const coord = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(coord, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(coord, 'agents.json'), '{}\n', 'utf-8');
  fs.writeFileSync(path.join(coord, 'requests.jsonl'), '', 'utf-8');
  fs.writeFileSync(path.join(coord, 'decisions.json'), '[]\n', 'utf-8');
  return coord;
}

function decision(id) {
  return {
    request_id: id,
    decision: `Decision for ${id}`,
    reason: `Reason for ${id}`,
  };
}

function startDashboard(coord) {
  const child = spawn(process.execPath, [dashboardPath, '--coord', coord], {
    cwd: repoRoot(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

async function waitForOutput(child, predicate) {
  return waitFor(() => {
    if (predicate(child.output)) return child.output;
    return false;
  }, { timeoutMs: 5000, intervalMs: 25 });
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupProcess(child);
      reject(new Error('dashboard did not exit'));
    }, 5000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: child.output });
    });
  });
}
