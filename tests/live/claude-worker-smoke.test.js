"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runLiveWorkerSmoke } = require("./helpers/live-harness");

test("claude lower-model worker completes a simple file task with fake arbitration", { timeout: 11 * 60 * 1000 }, async (t) => {
  const result = await runLiveWorkerSmoke(t, "claude");
  if (result.skipped) return;

  assert.equal(result.provider, "claude");
  assert.equal(result.reviewRequest.type, "review_request");
});
