'use strict';

// Narrow unit coverage for the `parkRationale` helper (Async Manual
// Intervention, Batch 2 follow-up). It owns the human recovery guidance
// written into `next_steps` for the three Class B "no cheap recovery" park
// sites — liveness timeout, restart-budget exhausted, hard-restart recovery
// failed. Those sites only run inside the orchestrator loop subprocess, which
// `--experimental-test-coverage` cannot instrument; the full transition is
// exercised end-to-end by loop-behavior.test.js and
// orchestrator-loop-failures.test.js. This file pins the site -> rationale
// mapping in-process so the routing intent is regression-protected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parkRationale } = require('../scripts/lib/status');

describe('parkRationale', () => {
  it('maps liveness_timeout to wedged-worker / broken-setup guidance', () => {
    const next = parkRationale('liveness_timeout');
    assert.match(next, /no log output/);
    assert.match(next, /CLI\/auth\/model setup/);
  });

  it('maps restart_budget_exhausted to spent-cheap-path guidance', () => {
    const next = parkRationale('restart_budget_exhausted');
    assert.match(next, /no restart budget remaining/);
    assert.match(next, /just loop/);
  });

  it('maps hard_restart_recovery_failed to no-further-fallback guidance', () => {
    const next = parkRationale('hard_restart_recovery_failed');
    assert.match(next, /recovery\/reset primitive itself/);
    assert.match(next, /no further automatic fallback/);
  });

  it('round-trips every known site to a non-empty string', () => {
    for (const site of ['liveness_timeout', 'restart_budget_exhausted', 'hard_restart_recovery_failed']) {
      const next = parkRationale(site);
      assert.ok(typeof next === 'string' && next.length > 0, `${site} -> string`);
    }
  });

  it('throws on an unknown site', () => {
    assert.throws(() => parkRationale('not_a_site'), /Unknown park site: not_a_site/);
  });
});
