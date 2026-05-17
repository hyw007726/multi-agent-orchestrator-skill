'use strict';

// Batch 3 (Async Manual Intervention): the dashboard must distinguish a parked
// `needs_attention` agent from a healthy/errored one and surface its
// attention_reason. Mirrors dashboard.test.js — spawn the dashboard as a
// subprocess and read its stdout. Piped stdout is not a TTY, so the amber
// escape is intentionally skipped here and the assertions pin the plain
// `ATTENTION:` token and the reason text (color is exercised by the isTTY/
// NO_COLOR guard, not asserted from captured bytes).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { repoRoot, waitFor, cleanupProcess } = require('./helpers/temp-project');

const dashboardPath = path.join(repoRoot(), 'scripts', 'dashboard.js');

describe('dashboard needs_attention surfacing', () => {
  it('shows the ATTENTION token and attention_reason for a parked agent', async () => {
    const coord = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-attention-'));
    fs.mkdirSync(path.join(coord, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(coord, 'requests.jsonl'), '', 'utf-8');
    fs.writeFileSync(path.join(coord, 'decisions.json'), '[]\n', 'utf-8');
    let child;
    try {
      fs.writeFileSync(path.join(coord, 'agents.json'), JSON.stringify({
        'agent-parked': {
          status: 'needs_attention',
          task: 'Build the parser',
          pid: 4242,
          attention_reason: 'liveness timeout - idle 30 mins',
          attention_at: '2026-05-18T00:00:00.000Z',
        },
        'agent-running': {
          status: 'running',
          task: 'Implement the renderer',
          pid: 12345,
        },
      }, null, 2), 'utf-8');
      fs.writeFileSync(path.join(coord, 'logs', 'agent-running.log'), 'Editing file: src/app.js\n', 'utf-8');

      child = startDashboard(coord);
      const output = await waitForOutput(
        child,
        (text) => text.includes('agent-parked') && text.includes('agent-running'),
      );

      assert.match(output, /ATTENTION:/);
      assert.match(output, /liveness timeout - idle 30 mins/);
      assert.match(output, /agent-running/);
      // Only the parked agent is tagged; the running one is not.
      const latestRender = output.slice(output.lastIndexOf('AGENT STATUS'));
      assert.strictEqual((latestRender.match(/ATTENTION:/g) || []).length, 1);

      child.kill('SIGTERM');
    } finally {
      cleanupProcess(child);
      fs.rmSync(coord, { recursive: true, force: true });
    }
  });
});

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
