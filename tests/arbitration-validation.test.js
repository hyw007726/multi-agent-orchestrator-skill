'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateArbitrationResponse } = require('../scripts/lib/arbitration');

describe('validateArbitrationResponse', () => {
  it('accepts a response that resolves every pending request', () => {
    const pending = [
      { request_id: 'q-1', agent: 'a', status: 'pending', type: 'question' },
      { request_id: 'q-2', agent: 'b', status: 'pending', type: 'question' },
    ];
    const response = {
      approved: [{ request_id: 'q-1', decision: 'ok', reason: 'fine' }],
      rejected: [{ request_id: 'q-2', reason: 'no' }],
      actions: [],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.deepStrictEqual(result, { ok: true });
  });

  it('rejects when a pending request is missing from approved+rejected', () => {
    const pending = [
      { request_id: 'q-1', agent: 'a', status: 'pending', type: 'question' },
      { request_id: 'q-2', agent: 'b', status: 'pending', type: 'question' },
    ];
    const response = {
      approved: [{ request_id: 'q-1', decision: 'ok' }],
      rejected: [],
      actions: [],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.strictEqual(result.ok, false);
    assert.match(result.reasons.join('\n'), /q-2/);
  });

  it('rejects when end_agent targets an agent whose request was not approved/rejected', () => {
    const pending = [
      { request_id: 'r-1', agent: 'agent-x', status: 'pending', type: 'review_request' },
      { request_id: 'q-y', agent: 'agent-y', status: 'pending', type: 'question' },
    ];
    // end_agent targets agent-x but we don't resolve r-1.
    const response = {
      approved: [{ request_id: 'q-y', decision: 'ok' }],
      rejected: [],
      actions: [{ type: 'end_agent', agent: 'agent-x' }],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.strictEqual(result.ok, false);
    assert.match(result.reasons.join('\n'), /agent-x/);
    // Other missing pending should also be flagged so a single fix doesn't mask others.
    assert.match(result.reasons.join('\n'), /r-1/);
  });

  it('rejects when soft_restart targets an agent whose request is unresolved', () => {
    const pending = [
      { request_id: 't-1', agent: 'agent-z', status: 'pending', type: 'progress_timeout' },
    ];
    const response = {
      approved: [],
      rejected: [],
      actions: [{ type: 'soft_restart', agent: 'agent-z' }],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.strictEqual(result.ok, false);
    assert.match(result.reasons.join('\n'), /soft_restart/);
  });

  it('accepts hard_restart when the agent has at least one resolved request in the same response', () => {
    const pending = [
      { request_id: 't-1', agent: 'agent-z', status: 'pending', type: 'progress_timeout' },
    ];
    const response = {
      approved: [{ request_id: 't-1', decision: 'restart', reason: 'stuck' }],
      rejected: [],
      actions: [{ type: 'hard_restart', agent: 'agent-z' }],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.deepStrictEqual(result, { ok: true });
  });

  it('treats restart_agent (legacy alias) the same as soft_restart', () => {
    const pending = [
      { request_id: 't-1', agent: 'agent-z', status: 'pending', type: 'progress_timeout' },
    ];
    const response = {
      approved: [],
      rejected: [],
      actions: [{ type: 'restart_agent', agent: 'agent-z' }],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.strictEqual(result.ok, false);
    assert.match(result.reasons.join('\n'), /restart_agent/);
  });

  it('rejects a non-object response', () => {
    assert.strictEqual(validateArbitrationResponse(null, []).ok, false);
    assert.strictEqual(validateArbitrationResponse('string', []).ok, false);
  });

  it('rejects an action missing the agent field', () => {
    const pending = [
      { request_id: 'q-1', agent: 'a', status: 'pending', type: 'question' },
    ];
    const response = {
      approved: [{ request_id: 'q-1', decision: 'ok' }],
      rejected: [],
      actions: [{ type: 'end_agent' }],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.strictEqual(result.ok, false);
    assert.match(result.reasons.join('\n'), /missing 'agent'/);
  });

  it('accepts an empty response when there are no pending requests', () => {
    const result = validateArbitrationResponse({ approved: [], rejected: [], actions: [] }, []);
    assert.deepStrictEqual(result, { ok: true });
  });

  // The orchestrator already has a per-action drop for ghost agents
  // (dropUnknownAgentAction → arbitration_action_dropped event). We do NOT
  // reject the whole response on that case: a single hallucinated action
  // should not be able to poison legitimate approvals in the same envelope.
  it('does not reject when an action targets a ghost agent absent from pending', () => {
    const pending = [
      { request_id: 'q-1', agent: 'known-agent', status: 'pending', type: 'question' },
    ];
    const response = {
      approved: [{ request_id: 'q-1', decision: 'ok' }],
      rejected: [],
      actions: [{ type: 'soft_restart', agent: 'ghost-agent', instruction: 'try again' }],
    };
    const result = validateArbitrationResponse(response, pending);
    assert.deepStrictEqual(result, { ok: true });
  });
});
