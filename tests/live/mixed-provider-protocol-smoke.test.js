"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  MIXED_PROVIDER_TARGET,
  liveRoleMappings,
  runAllLiveSmoke,
} = require("./helpers/live-harness");

test("mixed-provider reviewer, arbitrator, and worker complete the protocol handoff", { timeout: 16 * 60 * 1000 }, async (t) => {
  const result = await runAllLiveSmoke(t, MIXED_PROVIDER_TARGET);
  if (result.skipped) return;

  const expectedRoles = liveRoleMappings(MIXED_PROVIDER_TARGET);
  assert.equal(result.provider, "mixed");
  assert.equal(result.roles.reviewer.provider, expectedRoles.reviewer.provider);
  assert.equal(result.roles.arbitrator.provider, expectedRoles.arbitrator.provider);
  assert.equal(result.roles.worker.provider, expectedRoles.worker.provider);
  assert.equal(result.gateRequest.request_id, "agent-live-req-output-text");
  assert.equal(result.gateRequest.type, "question");
  assert.equal(result.gateRequest.status, "resolved");
  assert.equal(result.gateDecision.disposition, "approved");
  assert.equal(result.reviewRequest.type, "review_request");
  assert.equal(result.reviewRequest.status, "resolved");
  assert.equal(result.gateDecisionBeforeOutput, true);
  assert.equal(result.finalReviewAudited, true);
});
