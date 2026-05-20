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
        roles: {
          arbitrator: {
            alias: "gemini-live-arbitrator",
            provider: "gemini",
            provider_cli: "gemini",
            model: "gemini-2.5-flash-lite",
          },
        },
        models: { arbitrator: "gemini-2.5-flash-lite" },
        tail_command: `tail -F ${path.join(workspace, "coord", "orchestrator.log")}`,
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
      fs.writeFileSync(path.join(workspace, "coord", "events.jsonl"), `${JSON.stringify({
        timestamp: "2026-05-08T00:00:01.000Z",
        event: "arbitration_action_dropped",
        agent: "ghost-agent",
        reason: "Arbitration action targeted unknown agent ghost-agent",
      })}\n`, "utf-8");
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
      assert.strictEqual(info.orchestrator_pid, 12345);
      assert.strictEqual(info.roles.arbitrator.provider, "gemini");
      assert.strictEqual(info.pending_requests.length, 1);
      assert.strictEqual(info.recent_events.length, 1);
      assert.strictEqual(info.recent_events[0].event, "arbitration_action_dropped");
      assert.strictEqual(info.detections[0].type, "interactive_auth_prompt");
      assert.ok(info.tail_commands.some((entry) => entry.label === "session"));
      assert.ok(info.tail_commands.some((entry) => entry.label.startsWith("reviewer ")));

      const report = formatInspection(info);
      assert.match(report, /Session ID: live-gemini-arbitrator--abc123/);
      assert.match(report, /Role Mappings:/);
      assert.match(report, /arbitrator: alias=gemini-live-arbitrator provider=gemini model=gemini-2\.5-flash-lite provider_cli=gemini/);
      assert.match(report, /Tail Commands:/);
      assert.match(report, /reviewer gemini-live-reviewer\.md: tail -F /);
      assert.match(report, /arbitration_action_dropped agent=ghost-agent/);
      assert.match(report, /interactive_auth_prompt/);
      assert.match(report, /tail -n 120/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows mixed-provider role mappings and copyable tail commands", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-mixed-live-test-"));
    try {
      const workspace = path.join(root, "live-mixed-all-live--abc123");
      const coord = path.join(workspace, "coord");
      fs.mkdirSync(path.join(coord, "logs"), { recursive: true });
      fs.mkdirSync(path.join(coord, "plan-reviews", "iteration-1"), { recursive: true });

      fs.writeFileSync(path.join(coord, "live-test-session.json"), JSON.stringify({
        session_id: "live-mixed-all-live--abc123",
        provider: "mixed",
        test: "all-live",
        roles: {
          planner: { alias: "mixed-live-planner", provider: "claude", provider_cli: "claude", model: "claude-sonnet-4-6" },
          reviewer: { alias: "mixed-live-reviewer", provider: "codex", provider_cli: "codex", model: "gpt-5.4-mini" },
          arbitrator: { alias: "mixed-live-arbitrator", provider: "gemini", provider_cli: "gemini", model: "gemini-2.5-flash-lite" },
          worker: { alias: "mixed-live-worker", provider: "kilo", provider_cli: "kilo", model: "cli-default" },
        },
        models: {
          planner: "claude-sonnet-4-6",
          reviewer: "gpt-5.4-mini",
          arbitrator: "gemini-2.5-flash-lite",
          worker: "cli-default",
        },
        tail_command: `tail -F ${path.join(coord, "plan-reviews", "iteration-1", "mixed-live-reviewer.md")} ${path.join(coord, "orchestrator.log")} ${path.join(coord, "logs", "agent-live-all.log")}`,
      }), "utf-8");
      fs.writeFileSync(path.join(coord, "agents.json"), JSON.stringify({
        "agent-live-all": { status: "running", pid: 24680, cli: "mixed-live-worker", worktree: workspace },
      }), "utf-8");
      fs.writeFileSync(path.join(coord, "requests.jsonl"), "", "utf-8");
      fs.writeFileSync(path.join(coord, "decisions.json"), "[]\n", "utf-8");
      fs.writeFileSync(path.join(coord, "plan-reviews", "iteration-1", "mixed-live-reviewer.md"), "reviewer stream\n", "utf-8");
      fs.writeFileSync(path.join(coord, "orchestrator.log"), "orchestrator stream\n", "utf-8");
      fs.writeFileSync(path.join(coord, "logs", "agent-live-all.log"), "worker stream\n", "utf-8");

      const info = inspectLiveWorkspace(workspace);
      assert.strictEqual(info.provider, "mixed");
      assert.strictEqual(info.roles.reviewer.provider, "codex");
      assert.strictEqual(info.roles.arbitrator.provider, "gemini");
      assert.strictEqual(info.roles.worker.provider, "kilo");
      assert.ok(info.tail_commands.some((entry) => entry.label === "reviewer mixed-live-reviewer.md"));
      assert.ok(info.tail_commands.some((entry) => entry.label === "orchestrator log"));
      assert.ok(info.tail_commands.some((entry) => entry.label === "agent-live-all log"));

      const report = formatInspection(info);
      assert.match(report, /Provider: mixed/);
      assert.match(report, /planner: alias=mixed-live-planner provider=claude model=claude-sonnet-4-6 provider_cli=claude/);
      assert.match(report, /reviewer: alias=mixed-live-reviewer provider=codex model=gpt-5\.4-mini provider_cli=codex/);
      assert.match(report, /arbitrator: alias=mixed-live-arbitrator provider=gemini model=gemini-2\.5-flash-lite provider_cli=gemini/);
      assert.match(report, /worker: alias=mixed-live-worker provider=kilo model=cli-default provider_cli=kilo/);
      assert.match(report, /reviewer mixed-live-reviewer\.md: tail -F /);
      assert.match(report, /orchestrator log: tail -F /);
      assert.match(report, /agent-live-all log: tail -F /);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
