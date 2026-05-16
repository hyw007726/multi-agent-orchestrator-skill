"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runAllLiveSmoke } = require("./helpers/live-harness");

test("opencode configured-model reviewer, arbitrator, and worker complete the all-live protocol", { timeout: 16 * 60 * 1000 }, async (t) => {
  const result = await runAllLiveSmoke(t, "opencode");
  if (result.skipped) return;

  assert.equal(result.provider, "opencode");
  assert.equal(result.gateRequest.request_id, "agent-live-req-output-text");
  assert.equal(result.gateDecision.disposition, "approved");
  assert.equal(result.reviewRequest.type, "review_request");
});
