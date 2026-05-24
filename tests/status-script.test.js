'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const statusScript = path.resolve(__dirname, '..', 'scripts', 'status.js');

describe('status.js CLI', () => {
  it('reports no_run when coord/ is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-noop-'));
    try {
      const result = runStatus(tmp, '--coord', './coord', '--json');
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.ok, true);
      assert.strictEqual(payload.loop_state, 'no_run');
      assert.deepStrictEqual(payload.agents, []);
      assert.strictEqual(payload.stalled, null);
      assert.strictEqual(payload.abort_requested, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('summarizes agents, last events, blockers, and detects stalled state', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-snapshot-'));
    try {
      const coord = path.join(tmp, 'coord');
      fs.mkdirSync(coord, { recursive: true });
      fs.writeFileSync(
        path.join(coord, 'agents.json'),
        JSON.stringify({
          'agent-alpha': { status: 'running', pid: 111 },
          'agent-beta': {
            status: 'needs_attention',
            attention_reason: 'liveness timeout',
          },
        }, null, 2),
      );
      const events = [
        { timestamp: '2026-01-01T00:00:00.000Z', event: 'agent_spawned', agent: 'agent-alpha' },
        { timestamp: '2026-01-01T00:00:01.000Z', event: 'agent_spawned', agent: 'agent-beta' },
        { timestamp: '2026-01-01T00:00:02.000Z', event: 'agent_parked', agent: 'agent-beta', reason: 'liveness timeout' },
      ];
      fs.writeFileSync(path.join(coord, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      fs.writeFileSync(
        path.join(coord, 'orchestrator-stalled.flag'),
        JSON.stringify({ message: 'arbitration CLI down', timestamp: '2026-01-01T00:00:03.000Z' }),
      );

      const jsonResult = runStatus(tmp, '--coord', './coord', '--json');
      assert.strictEqual(jsonResult.status, 0, jsonResult.stderr);
      const payload = JSON.parse(jsonResult.stdout);
      assert.strictEqual(payload.ok, true);
      assert.strictEqual(payload.loop_state, 'stalled');
      assert.ok(payload.stalled && payload.stalled.message === 'arbitration CLI down');

      const alpha = payload.agents.find((a) => a.name === 'agent-alpha');
      const beta = payload.agents.find((a) => a.name === 'agent-beta');
      assert.strictEqual(alpha.status, 'running');
      assert.strictEqual(alpha.last_event_seq, 1);
      assert.strictEqual(alpha.last_event, 'agent_spawned');
      assert.ok(!('blocker' in alpha));

      assert.strictEqual(beta.status, 'needs_attention');
      assert.strictEqual(beta.last_event_seq, 3);
      assert.strictEqual(beta.last_event, 'agent_parked');
      assert.strictEqual(beta.blocker, 'liveness timeout');

      const humanResult = runStatus(tmp, '--coord', './coord');
      assert.strictEqual(humanResult.status, 0, humanResult.stderr);
      assert.match(humanResult.stdout, /Loop state: stalled/);
      assert.match(humanResult.stdout, /agent-alpha: running/);
      assert.match(humanResult.stdout, /agent-beta: needs_attention/);
      assert.match(humanResult.stdout, /blocker=liveness timeout/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports loop_state=completed when all agents are terminal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-complete-'));
    try {
      const coord = path.join(tmp, 'coord');
      fs.mkdirSync(coord, { recursive: true });
      fs.writeFileSync(
        path.join(coord, 'agents.json'),
        JSON.stringify({
          'agent-one': { status: 'completed' },
          'agent-two': { status: 'exited' },
        }, null, 2),
      );
      const result = runStatus(tmp, '--coord', './coord', '--json');
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.loop_state, 'completed');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports loop_state=aborting when abort.flag is set with live agents', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-abort-'));
    try {
      const coord = path.join(tmp, 'coord');
      fs.mkdirSync(coord, { recursive: true });
      fs.writeFileSync(
        path.join(coord, 'agents.json'),
        JSON.stringify({ 'agent-one': { status: 'running' } }, null, 2),
      );
      fs.writeFileSync(path.join(coord, 'abort.flag'), '{}');
      const result = runStatus(tmp, '--coord', './coord', '--json');
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.loop_state, 'aborting');
      assert.strictEqual(payload.abort_requested, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function runStatus(cwd, ...args) {
  return spawnSync(process.execPath, [statusScript, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
}
