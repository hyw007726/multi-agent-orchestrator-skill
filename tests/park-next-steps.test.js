'use strict';

// Narrow unit coverage for the `parkNextSteps` helper extracted in Batch 2
// (Async Manual Intervention). The three park sites it serves — liveness
// timeout, restart-budget exhausted, hard-restart recovery failed — only run
// inside the orchestrator loop subprocess, which `--experimental-test-coverage`
// cannot instrument. The full transition is exercised end-to-end by
// loop-behavior.test.js and orchestrator-loop-failures.test.js; this file pins
// the site -> buildProgressEscalation rationale mapping in-process so the
// "no cheap recovery -> manual inspection" intent is regression-protected and
// the helper is covered without spawning a loop.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parkNextSteps } = require('../scripts/orchestrator-loop');

const parsedConfig = { default_max_restarts: 3, default_progress_timeout_mins: 10 };

describe('parkNextSteps', () => {
  it('maps restart-budget-exhausted to the budget-exhausted rationale', () => {
    const next = parkNextSteps('restart_budget_exhausted', { restart_count: 3 }, parsedConfig);
    assert.match(next, /no restart budget remaining/);
    assert.match(next, /manual inspection/);
  });

  it('maps liveness timeout to manual inspection even with restart budget intact', () => {
    const next = parkNextSteps('liveness_timeout', { restart_count: 0 }, parsedConfig);
    assert.match(next, /manual inspection/);
  });

  it('maps hard-restart recovery failure to manual inspection even with restart budget intact', () => {
    const next = parkNextSteps('hard_restart_recovery_failed', { restart_count: 0 }, parsedConfig);
    assert.match(next, /manual inspection/);
  });

  it('tolerates a missing default_max_restarts', () => {
    const next = parkNextSteps('liveness_timeout', {}, {});
    assert.ok(typeof next === 'string' && next.length > 0);
  });
});
