'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBoundedArbitrationPrompt,
  ARBITRATION_PROMPT_CAP_BYTES,
} = require('../scripts/lib/arbitration');

describe('buildBoundedArbitrationPrompt section caps', () => {
  function basePending() {
    return [{
      request_id: 'q-1',
      agent: 'agent-a',
      status: 'pending',
      type: 'question',
      content: 'short content',
    }];
  }

  it('returns the full prompt unchanged when under the cap', () => {
    const logs = [];
    const prompt = buildBoundedArbitrationPrompt({
      pending: basePending(),
      context: { project: 'p' },
      durableDecisions: 'durable text',
      recentDecisions: [{ id: 'd-1' }],
      worktreeStates: {},
      callerContext: 'caller text',
      log: (m) => logs.push(m),
    });
    assert.ok(prompt.includes('durable text'));
    assert.ok(prompt.includes('caller text'));
    assert.strictEqual(logs.length, 0, 'no truncation log when prompt fits');
  });

  it('truncates oversized durableDecisions and names the section in the log', () => {
    const logs = [];
    const huge = 'D'.repeat(64 * 1024); // 64 KB, far over the per-section cap
    const prompt = buildBoundedArbitrationPrompt({
      pending: basePending(),
      context: { project: 'p' },
      durableDecisions: huge,
      recentDecisions: [],
      worktreeStates: {},
      callerContext: '',
      log: (m) => logs.push(m),
    });
    assert.ok(
      Buffer.byteLength(prompt, 'utf-8') <= ARBITRATION_PROMPT_CAP_BYTES,
      'compact prompt fits under the overall cap',
    );
    assert.ok(prompt.includes('[...truncated'), 'middle-truncation marker present');
    assert.strictEqual(logs.length, 1, 'exactly one truncation log line');
    assert.match(logs[0], /Arbitration prompt exceeded/);
    assert.match(logs[0], /durableDecisions -\d+B/, 'log names durableDecisions and bytes saved');
  });

  it('truncates oversized callerContext and names the section in the log', () => {
    const logs = [];
    const huge = 'C'.repeat(64 * 1024);
    const prompt = buildBoundedArbitrationPrompt({
      pending: basePending(),
      context: { project: 'p' },
      durableDecisions: '',
      recentDecisions: [],
      worktreeStates: {},
      callerContext: huge,
      log: (m) => logs.push(m),
    });
    assert.ok(
      Buffer.byteLength(prompt, 'utf-8') <= ARBITRATION_PROMPT_CAP_BYTES,
      'compact prompt fits under the overall cap',
    );
    assert.strictEqual(logs.length, 1, 'exactly one truncation log line');
    assert.match(logs[0], /callerContext -\d+B/, 'log names callerContext and bytes saved');
  });

  it('truncates oversized context (JSON-stringified) and names the section in the log', () => {
    const logs = [];
    const fatContext = { project: 'p', notes: 'N'.repeat(64 * 1024) };
    const prompt = buildBoundedArbitrationPrompt({
      pending: basePending(),
      context: fatContext,
      durableDecisions: '',
      recentDecisions: [],
      worktreeStates: {},
      callerContext: '',
      log: (m) => logs.push(m),
    });
    assert.ok(Buffer.byteLength(prompt, 'utf-8') <= ARBITRATION_PROMPT_CAP_BYTES);
    assert.match(logs[0], /context -\d+B/);
  });

  it('truncates oversized recentDecisions (JSON-stringified) and names the section in the log', () => {
    const logs = [];
    const fatDecisions = Array.from({ length: 2000 }, (_, i) => ({
      id: `d-${i}`,
      note: 'a long note '.repeat(20),
    }));
    const prompt = buildBoundedArbitrationPrompt({
      pending: basePending(),
      context: { project: 'p' },
      durableDecisions: '',
      recentDecisions: fatDecisions,
      worktreeStates: {},
      callerContext: '',
      log: (m) => logs.push(m),
    });
    assert.ok(Buffer.byteLength(prompt, 'utf-8') <= ARBITRATION_PROMPT_CAP_BYTES);
    assert.match(logs[0], /recentDecisions -\d+B/);
  });

  it('names every truncated section when multiple non-request blobs overflow at once', () => {
    const logs = [];
    const big = (c) => c.repeat(64 * 1024);
    const prompt = buildBoundedArbitrationPrompt({
      pending: basePending(),
      context: { project: 'p', notes: big('N') },
      durableDecisions: big('D'),
      recentDecisions: [{ id: 'd', note: big('R') }],
      worktreeStates: {},
      callerContext: big('C'),
      log: (m) => logs.push(m),
    });
    assert.ok(Buffer.byteLength(prompt, 'utf-8') <= ARBITRATION_PROMPT_CAP_BYTES);
    assert.strictEqual(logs.length, 1, 'one log line summarizes all truncations');
    const line = logs[0];
    for (const section of ['context', 'durableDecisions', 'recentDecisions', 'callerContext']) {
      assert.match(line, new RegExp(`${section} -\\d+B`), `log names ${section}`);
    }
  });
});
