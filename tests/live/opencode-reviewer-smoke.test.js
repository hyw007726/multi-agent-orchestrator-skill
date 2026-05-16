"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runLiveReviewerSmoke } = require("./helpers/live-harness");

test("opencode configured-model reviewer returns valid plan-review JSON", { timeout: 11 * 60 * 1000 }, (t) => {
  const result = runLiveReviewerSmoke(t, "opencode");
  if (result.skipped) return;

  assert.equal(result.provider, "opencode");
  assert.equal(result.reviewer, "opencode-live-reviewer");
  assert.match(result.review.summary, /\S/);
});
