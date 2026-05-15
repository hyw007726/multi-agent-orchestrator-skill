"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  findLatestLiveWorkspace,
  formatInspection,
  inferWorkspaceId,
  inspectLiveWorkspace,
  parseArgs,
} = require("../scripts/inspect-live-test");

describe("live test inspection", () => {
  it("parses workspace and latest lookup arguments", () => {
    assert.deepStrictEqual(parseArgs(["/tmp/live-gemini-worker--abc"]), {
      workspace: "/tmp/live-gemini-worker--abc",
      latest: false,
      provider: null,
      idOnly: false,
      json: false,
    });
    assert.deepStrictEqual(parseArgs(["--latest", "gemini", "--id-only"]), {
      workspace: null,
      latest: true,
      provider: "gemini",
      idOnly: true,
      json: false,
    });
    assert.throws(() => parseArgs([]), /Provide a live test workspace/);
  });

  it("infers live session ids from workspace names", () => {
    assert.deepStrictEqual(inferWorkspaceId("/tmp/live-gemini-all-live--Pjvhm9"), {
      session_id: "live-gemini-all-live--Pjvhm9",
      provider: "gemini",
      test: "all-live",
    });
  });

  it("inspects preserved live test artifacts and detects auth prompts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-live-test-"));
    try {
      const older = path.join(root, "live-codex-reviewer--older");
      const workspace = path.join(root, "live-gemini-arbitrator--abc123");
      fs.mkdirSync(older, { recursive: true });
      fs.mkdirSync(path.join(workspace, "coord", "logs"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "coord", "orchestrator.instance.lock"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "coord", "plan-reviews", "iteration-1"), { recursive: true });

      fs.writeFileSync(path.join(workspace, "coord", "live-test-session.json"), JSON.stringify({
        session_id: "live-gemini-arbitrator--abc123",
        provider: "gemini",
        test: "arbitrator",
        models: { arbitrator: "gemini-2.5-flash-lite" },
      }), "utf-8");
      fs.writeFileSync(path.join(workspace, "coord", "orchestrator.instance.lock", "pid"), "12345\n", "utf-8");
      fs.writeFileSync(path.join(workspace, "coord", "agents.json"), JSON.stringify({
        "agent-live": { status: "running", pid: 23456, cli: "gemini-live-worker", worktree: workspace },
      }), "utf-8");
      fs.writeFileSync(path.join(workspace, "coord", "requests.jsonl"), `${JSON.stringify({
        request_id: "agent-live-req-output-text",
        agent: "agent-live",
        type: "question",
        status: "pending",
      })}\n`, "utf-8");
      fs.writeFileSync(path.join(workspace, "coord", "decisions.json"), "[]\n", "utf-8");
      fs.writeFileSync(
        path.join(workspace, "coord", "plan-reviews", "iteration-1", "gemini-live-reviewer.md"),
        "Opening authentication page in your browser. Do you want to continue? [Y/n]:",
        "utf-8"
      );
      fs.writeFileSync(path.join(workspace, "coord", "logs", "agent-live.log"), "worker output\n", "utf-8");

      assert.strictEqual(findLatestLiveWorkspace({ provider: "gemini", tmpDir: root }), workspace);

      const info = inspectLiveWorkspace(workspace);
      assert.strictEqual(info.session_id, "live-gemini-arbitrator--abc123");
      assert.strictEqual(info.provider, "gemini");
      assert.strictEqual(info.test, "arbitrator");
      assert.strictEqual(info.orchestrator_pid, "12345");
      assert.strictEqual(info.pending_requests.length, 1);
      assert.strictEqual(info.detections[0].type, "interactive_auth_prompt");

      const report = formatInspection(info);
      assert.match(report, /Session ID: live-gemini-arbitrator--abc123/);
      assert.match(report, /interactive_auth_prompt/);
      assert.match(report, /tail -n 120/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
