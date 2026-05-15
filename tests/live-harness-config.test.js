"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  liveTailCommand,
  writeAllLiveProviderConfig,
  writeLiveProviderConfig,
  writeLiveWorkerConfig,
} = require("./live/helpers/live-harness");

describe("live harness provider config", () => {
  it("uses absolute coord include directories for Gemini live templates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-live-config-"));
    try {
      const configWriters = [
        ["provider", writeLiveProviderConfig],
        ["all-live", writeAllLiveProviderConfig],
        ["worker", writeLiveWorkerConfig],
      ];

      for (const [name, writeConfig] of configWriters) {
        const projectRoot = path.join(root, name);
        fs.mkdirSync(projectRoot, { recursive: true });
        const config = writeConfig(projectRoot, "gemini");
        const expectedCoord = path.join(projectRoot, "coord");

        for (const template of Object.values(config.cli_templates)) {
          if (template.cmd !== "gemini") continue;
          const includeIndex = template.args.indexOf("--include-directories");
          assert.notStrictEqual(includeIndex, -1, `${name} template should include coord`);
          assert.strictEqual(template.args[includeIndex + 1], expectedCoord);
          assert.strictEqual(path.isAbsolute(template.args[includeIndex + 1]), true);
          assert.strictEqual(fs.existsSync(template.args[includeIndex + 1]), true);
          assert.strictEqual(template.args.includes("../../coord"), false);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints copyable tail commands for live test sessions", () => {
    const root = "/tmp/live-gemini-all-live--abc123";
    const allLive = liveTailCommand(root, "gemini", "all-live");
    assert.match(allLive, /^tail -F /);
    assert.match(allLive, /gemini-live-reviewer\.md/);
    assert.match(allLive, /orchestrator\.log/);
    assert.match(allLive, /agent-live-all\.log/);

    const arbitrator = liveTailCommand(root, "gemini", "arbitrator");
    assert.match(arbitrator, /^tail -F /);
    assert.match(arbitrator, /orchestrator\.log/);
    assert.doesNotMatch(arbitrator, /agent-live-all\.log/);
  });
});
