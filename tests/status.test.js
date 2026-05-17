'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { STATUS, transitionAgentStatus, parkAgentForAttention } = require('../scripts/lib/status');

describe('STATUS constants', () => {
  it('exposes needs_attention as a frozen, distinct value', () => {
    assert.strictEqual(STATUS.NEEDS_ATTENTION, 'needs_attention');
    assert.ok(Object.isFrozen(STATUS));
    assert.notStrictEqual(STATUS.NEEDS_ATTENTION, STATUS.ERRORED);
  });
});

describe('transitionAgentStatus', () => {
  it('accepts needs_attention and records the transition', () => {
    const logs = [];
    const agent = { status: 'running' };
    transitionAgentStatus(agent, 'agent-a', STATUS.NEEDS_ATTENTION, 'parked', (m) => logs.push(m));
    assert.strictEqual(agent.status, 'needs_attention');
    assert.ok(logs.some((m) => m.includes('running -> needs_attention')));
  });

  it('rejects an unknown status', () => {
    assert.throws(
      () => transitionAgentStatus({ status: 'running' }, 'agent-a', 'bogus', 'x', () => {}),
      /Invalid agent status: bogus/
    );
  });
});

describe('parkAgentForAttention', () => {
  it('flips status and sets attention fields atomically', () => {
    const agent = { status: 'running' };
    parkAgentForAttention(agent, 'agent-a', 'liveness timeout', () => {}, { nextSteps: 'inspect the worktree' });
    assert.strictEqual(agent.status, STATUS.NEEDS_ATTENTION);
    assert.strictEqual(agent.attention_reason, 'liveness timeout');
    assert.strictEqual(agent.next_steps, 'inspect the worktree');
    assert.ok(!Number.isNaN(Date.parse(agent.attention_at)), 'attention_at is an ISO timestamp');
  });

  it('omits next_steps when no guidance is supplied', () => {
    const agent = { status: 'running' };
    parkAgentForAttention(agent, 'agent-a', 'budget exhausted', () => {});
    assert.strictEqual(agent.status, STATUS.NEEDS_ATTENTION);
    assert.strictEqual(agent.attention_reason, 'budget exhausted');
    assert.ok(!('next_steps' in agent));
  });
});
