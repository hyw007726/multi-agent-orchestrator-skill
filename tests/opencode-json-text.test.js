"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  condenseLastPromptArg,
  condenseWorkerPrompt,
  extractTextFromJsonl,
  findNearestGitRoot,
  parseWrapperArgs,
  runOpenCodeJsonText,
} = require("../scripts/opencode-json-text");

describe("opencode-json-text", () => {
  it("extracts only model text events from OpenCode JSONL", () => {
    const jsonl = [
      JSON.stringify({ type: "start", sessionID: "abc" }),
      JSON.stringify({ type: "text", part: { type: "text", text: "{\"ok\":" } }),
      "not json",
      JSON.stringify({ type: "tool", name: "read" }),
      JSON.stringify({ type: "text", part: { type: "text", text: "true}" } }),
      "",
    ].join("\n");

    assert.strictEqual(extractTextFromJsonl(jsonl), "{\"ok\":true}");
  });

  it("runs OpenCode in JSON format and returns extracted text", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-json-text-"));
    try {
      const result = runOpenCodeJsonText(["--dangerously-skip-permissions", "prompt"], {
        cwd,
        spawnSyncImpl(cmd, args, options) {
          assert.strictEqual(cmd, "opencode");
          assert.deepEqual(args, ["run", "--format", "json", "--dangerously-skip-permissions", "prompt"]);
          assert.strictEqual(options.cwd, cwd);
          assert.strictEqual(options.encoding, "utf-8");
          return {
            status: 0,
            stdout: `${JSON.stringify({ type: "text", part: { text: "done" } })}\n`,
            stderr: "",
          };
        },
      });

      assert.deepEqual(result, { status: 0, stdout: "done", stderr: "" });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("strips wrapper-only cwd arguments before invoking OpenCode", () => {
    assert.deepEqual(
      parseWrapperArgs([
        "--opencode-json-text-cwd",
        "/tmp/project",
        "--opencode-json-text-live-worker-smoke",
        "--model",
        "provider/model",
        "prompt",
      ]),
      {
        cwd: "/tmp/project",
        liveWorkerSmoke: true,
        args: ["--model", "provider/model", "prompt"],
      }
    );
  });

  it("condenses the generic worker contract into a live smoke prompt", () => {
    const prompt = [
      "Agent name: agent-live-worker",
      "Project: Live worker smoke project",
      "Specific assignment: Create live-worker-output.txt.",
      "Start Here: README.md, coord/DECISIONS.md",
      "Worktree path: .agents/worktrees/agent-live-worker",
      "- **ALLOWED PATHS**: live-worker-output.txt (You may freely create/edit files here)",
      "- **FORBIDDEN PATHS**: coord/, package.json",
    ].join("\n");

    const cwd = path.join(os.tmpdir(), "live-opencode-worker--abc", ".agents", "worktrees", "agent-live-worker");
    const condensed = condenseWorkerPrompt(prompt, { cwd });
    assert.match(condensed, /You are agent-live-worker/);
    assert.match(condensed, /Create live-worker-output.txt/);
    assert.match(condensed, new RegExp(escapeRegExp(path.join(cwd, "live-worker-output.txt"))));
    assert.match(condensed, new RegExp(escapeRegExp(path.join(cwd, "coord", "requests"))));
    assert.match(condensed, /request_id, agent, type, priority, content, status, created_at/);
    assert.ok(condensed.length < 2500);

    assert.deepEqual(condenseLastPromptArg(["--model", "x", prompt], cwd), ["--model", "x", condensed]);
  });

  it("uses the nearest git root as OpenCode's working directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-json-text-"));
    const previousCwd = process.cwd();
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const nested = path.join(root, "coord", "plan-reviews", "iteration-1");
      fs.mkdirSync(nested, { recursive: true });
      process.chdir(nested);

      const result = runOpenCodeJsonText(["prompt"], {
        spawnSyncImpl(_cmd, _args, options) {
          assert.strictEqual(options.cwd, fs.realpathSync(root));
          return {
            status: 0,
            stdout: `${JSON.stringify({ type: "text", part: { text: "done" } })}\n`,
            stderr: "",
          };
        },
      });

      assert.deepEqual(result, { status: 0, stdout: "done", stderr: "" });
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the nearest git root for nested review artifact directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-git-root-"));
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const nested = path.join(root, "coord", "plan-reviews", "iteration-1");
      fs.mkdirSync(nested, { recursive: true });

      assert.strictEqual(findNearestGitRoot(nested), root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
