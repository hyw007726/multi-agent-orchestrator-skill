"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { progressTimeoutHistory } = require("../scripts/lib/progress-tracking");

describe("progressTimeoutHistory windowing", () => {
  const baseRequests = [
    { agent: "agent-a", type: "progress_timeout", created_at: "2026-01-01T00:00:00.000Z" },
    { agent: "agent-a", type: "progress_timeout", created_at: "2026-01-02T00:00:00.000Z" },
    { agent: "agent-a", type: "progress_timeout", created_at: "2026-01-03T00:00:00.000Z" },
    { agent: "agent-b", type: "progress_timeout", created_at: "2026-01-02T00:00:00.000Z" },
    { agent: "agent-a", type: "review_request", created_at: "2026-01-02T00:00:00.000Z" },
  ];

  it("counts all history when no reset_at is provided (legacy behavior)", () => {
    const result = progressTimeoutHistory(baseRequests, "agent-a", undefined);
    assert.strictEqual(result.previousCount, 3);
    assert.strictEqual(result.timeoutCount, 4);
  });

  it("filters out timeouts created before the reset_at watermark", () => {
    const result = progressTimeoutHistory(baseRequests, "agent-a", "2026-01-02T12:00:00.000Z");
    // Only 2026-01-03 timeout is after the watermark.
    assert.strictEqual(result.previousCount, 1);
    assert.strictEqual(result.timeoutCount, 2);
  });

  it("includes timeouts exactly at the reset_at watermark", () => {
    const result = progressTimeoutHistory(baseRequests, "agent-a", "2026-01-02T00:00:00.000Z");
    // 2026-01-02 and 2026-01-03 are >= watermark.
    assert.strictEqual(result.previousCount, 2);
    assert.strictEqual(result.timeoutCount, 3);
  });

  it("ignores other agents", () => {
    const result = progressTimeoutHistory(baseRequests, "agent-b", undefined);
    assert.strictEqual(result.previousCount, 1);
    assert.strictEqual(result.timeoutCount, 2);
  });

  it("falls back to all-history when reset_at is unparseable", () => {
    const result = progressTimeoutHistory(baseRequests, "agent-a", "not-a-timestamp");
    assert.strictEqual(result.previousCount, 3);
    assert.strictEqual(result.timeoutCount, 4);
  });

  it("ignores requests with missing created_at when a reset_at is set", () => {
    const requests = [
      { agent: "agent-a", type: "progress_timeout" }, // no created_at
      { agent: "agent-a", type: "progress_timeout", created_at: "2026-02-01T00:00:00.000Z" },
    ];
    const result = progressTimeoutHistory(requests, "agent-a", "2026-01-15T00:00:00.000Z");
    assert.strictEqual(result.previousCount, 1);
    assert.strictEqual(result.timeoutCount, 2);
  });

  it("returns first_timeout count when no history matches", () => {
    const result = progressTimeoutHistory(baseRequests, "agent-c", undefined);
    assert.strictEqual(result.previousCount, 0);
    assert.strictEqual(result.timeoutCount, 1);
  });
});
