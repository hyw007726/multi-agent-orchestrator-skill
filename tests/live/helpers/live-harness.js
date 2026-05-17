"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  cleanupProcess,
  createTempProject,
  repoRoot,
  readJson,
  readJsonl,
  waitFor,
} = require("../../helpers/temp-project");

const launchAllPath = path.join(repoRoot(), "scripts", "launch-all.js");
const orchestratorLoopPath = path.join(repoRoot(), "scripts", "orchestrator-loop.js");
const openCodeJsonTextPath = path.join(repoRoot(), "scripts", "opencode-json-text.js");
const reviewPlanPath = path.join(repoRoot(), "scripts", "review-plan.js");

const PROVIDERS = {
  claude: {
    envPrefix: "CLAUDE",
    cli: "claude",
    defaultModel: "claude-sonnet-4-6",
    healthCheck: "claude --version",
    template(model) {
      return {
        cmd: "claude",
        args: ["-p", { prompt_text: true }, "--dangerously-skip-permissions", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--model", model],
      };
    },
  },
  codex: {
    envPrefix: "CODEX",
    cli: "codex",
    defaultModel: "gpt-5.4-mini",
    healthCheck: "codex --version",
    template(model) {
      return {
        cmd: "codex",
        args: ["exec", "--model", model, "--dangerously-bypass-approvals-and-sandbox", { prompt_text: true }],
      };
    },
  },
  gemini: {
    envPrefix: "GEMINI",
    cli: "gemini",
    defaultModel: "gemini-2.5-flash-lite",
    healthCheck: "gemini --version",
    template(model, options = {}) {
      const args = ["--prompt", "", "--yolo", "--skip-trust", "--output-format", "stream-json"];
      if (options.includeCoordDir) {
        args.push("--include-directories", options.includeCoordDir);
      }
      args.push("--model", model);
      return {
        cmd: "gemini",
        args,
        stdin: { prompt_file: true },
      };
    },
  },
  kilo: {
    envPrefix: "KILO",
    cli: "kilo",
    defaultModel: "cli-default",
    healthCheck: "kilo --version",
    template(model) {
      const args = ["run", "--auto"];
      if (model && model !== "cli-default") {
        args.push("--model", model);
      }
      args.push({ prompt_text: true });
      return {
        cmd: "kilo",
        args,
      };
    },
  },
  opencode: {
    envPrefix: "OPENCODE",
    cli: "opencode",
    defaultModel: "cli-default",
    healthCheck: "opencode --version",
    template(model, options = {}) {
      const args = [openCodeJsonTextPath, "--dangerously-skip-permissions"];
      if (options.role === "reviewer" || options.role === "arbitrator") {
        args.push("--opencode-json-text-cwd", repoRoot());
      }
      if (options.role === "worker") {
        args.push("--opencode-json-text-live-worker-smoke");
      }
      if (model && model !== "cli-default") {
        args.push("--model", model);
      }
      args.push("--file", { prompt_file: true }, "Follow the instructions in the attached prompt file.");
      return {
        cmd: process.execPath,
        args,
      };
    },
  },
};

const MIXED_PROVIDER_TARGET = "mixed";
const LIVE_ROLE_NAMES = ["planner", "reviewer", "arbitrator", "worker"];
const RUNTIME_ROLE_NAMES = ["reviewer", "arbitrator", "worker"];
const DEFAULT_MIXED_COMBO = "canonical";
const MIXED_ROLE_COMBOS = {
  canonical: {
    planner: { provider: "claude" },
    reviewer: { provider: "codex" },
    arbitrator: { provider: "gemini" },
    worker: { provider: "kilo" },
  },
  "opencode-worker": {
    planner: { provider: "claude" },
    reviewer: { provider: "gemini" },
    arbitrator: { provider: "codex" },
    worker: { provider: "opencode" },
  },
};
const MIXED_ROLE_DEFAULTS = MIXED_ROLE_COMBOS[DEFAULT_MIXED_COMBO];

const REQUIRED_REVIEWER_ARRAY_FIELDS = [
  "execution_mode_issues",
  "blockers",
  "overlaps",
  "missing_foundation_work",
  "sequencing_risks",
  "validation_gaps",
  "suggested_changes",
];

function runLiveReviewerSmoke(t, providerName) {
  const skipReason = liveSkipReason(providerName);
  if (skipReason) return skip(t, skipReason);

  const provider = roleProviderInfo(providerName, "reviewer");
  const probe = probeLiveRoleClis(providerName, ["reviewer"]);
  if (!probe.ok) return skip(t, probe.message);

  const project = createLiveProject(providerName, `live-${providerName}-reviewer-`);
  console.log(`\n[live-harness] Reviewer smoke test workspace: ${project.root}`);
  writeLiveSession(project.root, providerName, "reviewer");
  let preserveArtifacts = process.env.LIVE_KEEP_ARTIFACTS === "1";
  try {
    const aliases = providerAliases(providerName);
    writeLiveProviderConfig(project.root, providerName);
    writeReviewerSmokeDraft(project.root);

    const timeoutMs = liveTimeoutMs("REVIEWER", 10 * 60 * 1000);
    const result = spawnSync(process.execPath, [
      reviewPlanPath,
      "--iteration",
      "1",
      "--draft-plan",
      "./coord/plan-reviews/draft-plan-v1.json",
      "--coord",
      "./coord",
      "--timeout-ms",
      String(timeoutMs),
    ], {
      cwd: project.root,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs + 5000,
    });

    assert.strictEqual(
      result.status,
      0,
      [
        `${providerName} live reviewer smoke failed in ${project.root}`,
        ...roleFailureDetails(providerName, ["reviewer"]),
        `stdout:\n${result.stdout || "(empty)"}`,
        `stderr:\n${result.stderr || "(empty)"}`,
      ].join("\n\n")
    );

    const jsonPath = path.join(project.root, "coord", "plan-reviews", "iteration-1", `${aliases.reviewer}.json`);
    assert.ok(fs.existsSync(jsonPath), `expected reviewer artifact at ${jsonPath}`);
    const review = readJson(jsonPath);
    assertValidReviewerJson(review, aliases.reviewer, 1);

    return {
      provider: providerName,
      roles: liveRoleMappings(providerName),
      cli: provider.cli,
      model: roleModel(providerName, "reviewer"),
      reviewer: aliases.reviewer,
      review,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (err) {
    preserveArtifacts = true;
    if (isMixedTarget(providerName)) recordLiveFailure(project.root, providerName, err);
    throw err;
  } finally {
    if (preserveArtifacts) {
      console.log(`Keeping live test artifacts: ${project.root}`);
    } else {
      project.cleanup();
    }
  }
}

function runLiveArbitratorSmoke(t, providerName) {
  const skipReason = liveSkipReason(providerName);
  if (skipReason) return skip(t, skipReason);

  const provider = roleProviderInfo(providerName, "arbitrator");
  const probe = probeLiveRoleClis(providerName, ["arbitrator"]);
  if (!probe.ok) return skip(t, probe.message);

  const project = createLiveProject(providerName, `live-${providerName}-arbitrator-`);
  console.log(`\n[live-harness] Arbitrator smoke test workspace: ${project.root}`);
  writeLiveSession(project.root, providerName, "arbitrator");
  let preserveArtifacts = process.env.LIVE_KEEP_ARTIFACTS === "1";
  try {
    const aliases = providerAliases(providerName);
    writeLiveProviderConfig(project.root, providerName);
    writeArbitratorSmokeContext(project.root, providerName);

    const request = stageQuestionRequest(project.root, {
      request_id: "agent-live-req-output-text",
      agent: "agent-live-arbitrator",
      type: "question",
      priority: "medium",
      status: "pending",
      content: [
        "This is a live lower-model arbitrator smoke test.",
        "Please approve the exact output text `live worker smoke ok` for the future worker task.",
        "No file changes are requested by this question.",
      ].join(" "),
      created_at: new Date().toISOString(),
    });

    const timeoutMs = liveTimeoutMs("ARBITRATOR", 10 * 60 * 1000);
    const result = spawnSync(process.execPath, [
      orchestratorLoopPath,
      "--coord",
      "./coord",
      "--poll-interval",
      "250",
    ], {
      cwd: project.root,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs + 5000,
    });

    assert.strictEqual(
      result.status,
      0,
      [
        `${providerName} live arbitrator smoke failed in ${project.root}`,
        ...roleFailureDetails(providerName, ["arbitrator"]),
        `stdout:\n${result.stdout || "(empty)"}`,
        `stderr:\n${result.stderr || "(empty)"}`,
      ].join("\n\n")
    );

    const requests = readJsonl(path.join(project.root, "coord", "requests.jsonl"));
    const resolvedRequest = requests.find((entry) => entry.request_id === request.request_id);
    assert.ok(resolvedRequest, "requests.jsonl should include the staged question request");
    assert.ok(
      resolvedRequest.status === "resolved" || resolvedRequest.status === "rejected",
      `request should be resolved or rejected, got ${resolvedRequest.status}`
    );

    const decisions = readJson(path.join(project.root, "coord", "decisions.json"));
    const decision = decisions.find((entry) => entry.request_id === request.request_id);
    assert.ok(decision, "decisions.json should include the arbitrator disposition");
    assert.ok(
      decision.disposition === "approved" || decision.disposition === "rejected",
      `decision disposition should be approved or rejected, got ${decision.disposition}`
    );

    const audit = readJsonl(path.join(project.root, "coord", "decisions.jsonl"));
    assert.ok(audit.some((entry) => entry.request_id === request.request_id), "decisions.jsonl should include the disposition audit entry");

    return {
      provider: providerName,
      roles: liveRoleMappings(providerName),
      cli: provider.cli,
      model: roleModel(providerName, "arbitrator"),
      request: resolvedRequest,
      decision,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (err) {
    preserveArtifacts = true;
    if (isMixedTarget(providerName)) recordLiveFailure(project.root, providerName, err);
    throw err;
  } finally {
    if (preserveArtifacts) {
      cleanupLiveProcesses(project.root);
      console.log(`Keeping live test artifacts: ${project.root}`);
    } else {
      project.cleanup();
    }
  }
}

async function runLiveWorkerSmoke(t, providerName) {
  const skipReason = liveSkipReason(providerName);
  if (skipReason) return skip(t, skipReason);

  const provider = roleProviderInfo(providerName, "worker");
  const probe = probeLiveRoleClis(providerName, ["worker"]);
  if (!probe.ok) return skip(t, probe.message);

  const project = createLiveProject(providerName, `live-${providerName}-worker-`);
  console.log(`\n[live-harness] Worker smoke test workspace: ${project.root}`);
  writeLiveSession(project.root, providerName, "worker");
  let loopPid = null;
  let preserveArtifacts = process.env.LIVE_KEEP_ARTIFACTS === "1";
  try {
    const aliases = providerAliases(providerName);
    writeLiveWorkerConfig(project.root, providerName);
    writeWorkerSmokeContext(project.root, providerName);

    const launchResult = spawnSync(process.execPath, [launchAllPath, "--coord", "./coord"], {
      cwd: project.root,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30 * 1000,
    });
    assert.strictEqual(
      launchResult.status,
      0,
      [
        `${providerName} live worker launch failed in ${project.root}`,
        ...roleFailureDetails(providerName, ["worker"]),
        `stdout:\n${launchResult.stdout || "(empty)"}`,
        `stderr:\n${launchResult.stderr || "(empty)"}`,
      ].join("\n\n")
    );

    const loopPidMatch = launchResult.stdout.match(/Orchestrator loop backgrounded \(PID:\s*(\d+)\)/);
    loopPid = loopPidMatch ? Number(loopPidMatch[1]) : null;
    updateLiveSession(project.root, { orchestrator_pid: loopPid });

    const timeoutMs = liveTimeoutMs("WORKER", 10 * 60 * 1000);
    const finalStatus = await waitFor(() => {
      const agentsPath = path.join(project.root, "coord", "agents.json");
      if (!fs.existsSync(agentsPath)) return false;
      const agents = readJson(agentsPath);
      const status = agents["agent-live-worker"]?.status;
      return ["completed", "errored", "exited", "terminated"].includes(status) ? status : false;
    }, { timeoutMs, intervalMs: 1000 });

    assert.strictEqual(
      finalStatus,
      "completed",
      liveFailureMessage(project.root, providerName, "worker did not complete")
    );

    const summaryPath = path.join(project.root, "coord", "review-summary.txt");
    await waitFor(() => fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf-8") : false, {
      timeoutMs: 30 * 1000,
      intervalMs: 500,
    });

    const outputPath = path.join(project.root, ".agents", "worktrees", "agent-live-worker", "live-worker-output.txt");
    assert.ok(fs.existsSync(outputPath), `expected worker output at ${outputPath}`);
    assert.strictEqual(fs.readFileSync(outputPath, "utf-8").trim(), "live worker smoke ok");

    const requests = readJsonl(path.join(project.root, "coord", "requests.jsonl"));
    const reviewRequest = requests.find((entry) =>
      entry.agent === "agent-live-worker" &&
      entry.type === "review_request" &&
      entry.status === "resolved"
    );
    assert.ok(reviewRequest, "requests.jsonl should include a resolved review_request for agent-live-worker");

    cleanupLiveProcesses(project.root, loopPid);
    loopPid = null;

    return {
      provider: providerName,
      roles: liveRoleMappings(providerName),
      cli: provider.cli,
      model: roleModel(providerName, "worker"),
      reviewer: aliases.reviewer,
      outputPath,
      reviewRequest,
    };
  } catch (err) {
    preserveArtifacts = true;
    if (isMixedTarget(providerName)) recordLiveFailure(project.root, providerName, err);
    throw err;
  } finally {
    cleanupLiveProcesses(project.root, loopPid);
    if (preserveArtifacts) {
      console.log(`Keeping live test artifacts: ${project.root}`);
    } else {
      project.cleanup();
    }
  }
}

async function runAllLiveSmoke(t, providerName) {
  const skipReason = liveSkipReason(providerName);
  if (skipReason) return skip(t, skipReason);

  const probe = probeLiveRoleClis(providerName, RUNTIME_ROLE_NAMES);
  if (!probe.ok) return skip(t, probe.message);

  const project = createLiveProject(providerName, `live-${providerName}-all-live-`);
  console.log(`\n[live-harness] All-live protocol test workspace: ${project.root}`);
  writeLiveSession(project.root, providerName, "all-live");
  let loopPid = null;
  let preserveArtifacts = process.env.LIVE_KEEP_ARTIFACTS === "1";
  try {
    const aliases = providerAliases(providerName);
    writeAllLiveProviderConfig(project.root, providerName);
    writeAllLiveDraft(project.root, providerName);

    const reviewerTimeoutMs = liveTimeoutMs("REVIEWER", 10 * 60 * 1000);
    const reviewResult = spawnSync(process.execPath, [
      reviewPlanPath,
      "--iteration",
      "1",
      "--draft-plan",
      "./coord/plan-reviews/draft-plan-v1.json",
      "--coord",
      "./coord",
      "--timeout-ms",
      String(reviewerTimeoutMs),
    ], {
      cwd: project.root,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: reviewerTimeoutMs + 5000,
    });
    const reviewerTransientSkip = transientProviderSkipReason(providerName, ["reviewer"], processResultText(reviewResult));
    if (reviewResult.status !== 0 && reviewerTransientSkip) return skip(t, reviewerTransientSkip);
    assert.strictEqual(
      reviewResult.status,
      0,
      [
        `${providerName} all-live reviewer phase failed in ${project.root}`,
        ...roleFailureDetails(providerName, ["reviewer"]),
        `stdout:\n${reviewResult.stdout || "(empty)"}`,
        `stderr:\n${reviewResult.stderr || "(empty)"}`,
      ].join("\n\n")
    );

    const review = readJson(path.join(project.root, "coord", "plan-reviews", "iteration-1", `${aliases.reviewer}.json`));
    assertValidReviewerJson(review, aliases.reviewer, 1);

    writeAllLiveContext(project.root, providerName);

    const launchResult = spawnSync(process.execPath, [launchAllPath, "--coord", "./coord"], {
      cwd: project.root,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30 * 1000,
    });
    const launchTransientSkip = transientProviderSkipReason(providerName, ["worker", "arbitrator"], processResultText(launchResult));
    if (launchResult.status !== 0 && launchTransientSkip) return skip(t, launchTransientSkip);
    assert.strictEqual(
      launchResult.status,
      0,
      [
        `${providerName} all-live worker launch failed in ${project.root}`,
        ...roleFailureDetails(providerName, ["worker", "arbitrator"]),
        `stdout:\n${launchResult.stdout || "(empty)"}`,
        `stderr:\n${launchResult.stderr || "(empty)"}`,
      ].join("\n\n")
    );

    const loopPidMatch = launchResult.stdout.match(/Orchestrator loop backgrounded \(PID:\s*(\d+)\)/);
    loopPid = loopPidMatch ? Number(loopPidMatch[1]) : null;
    updateLiveSession(project.root, { orchestrator_pid: loopPid });

    const timeoutMs = liveTimeoutMs("ALL_LIVE", 15 * 60 * 1000);
    let finalStatus;
    try {
      finalStatus = await waitFor(() => {
        const agentsPath = path.join(project.root, "coord", "agents.json");
        if (!fs.existsSync(agentsPath)) return false;
        const agents = readJson(agentsPath);
        const status = agents["agent-live-all"]?.status;
        return ["completed", "errored", "exited", "terminated"].includes(status) ? status : false;
      }, { timeoutMs, intervalMs: 1000 });
    } catch (err) {
      const transientSkip = transientProviderSkipReasonFromArtifacts(project.root, providerName, ["worker", "arbitrator"]);
      if (transientSkip) return skip(t, transientSkip);
      throw err;
    }

    if (finalStatus !== "completed") {
      const transientSkip = transientProviderSkipReasonFromArtifacts(project.root, providerName, ["worker", "arbitrator"]);
      if (transientSkip) return skip(t, transientSkip);
    }

    assert.strictEqual(
      finalStatus,
      "completed",
      liveFailureMessage(project.root, providerName, "all-live worker did not complete", "agent-live-all")
    );

    const outputPath = path.join(project.root, ".agents", "worktrees", "agent-live-all", "live-worker-output.txt");
    const protocolFailure = (reason) => liveFailureMessage(project.root, providerName, reason, "agent-live-all", RUNTIME_ROLE_NAMES);
    assert.ok(fs.existsSync(outputPath), protocolFailure(`expected all-live worker output at ${outputPath}`));
    assert.strictEqual(
      fs.readFileSync(outputPath, "utf-8").trim(),
      "live worker smoke ok",
      protocolFailure("live-worker-output.txt did not contain the expected text")
    );

    const requests = readJsonl(path.join(project.root, "coord", "requests.jsonl"));
    const gateRequest = requests.find((entry) => entry.request_id === "agent-live-req-output-text");
    assert.ok(gateRequest, protocolFailure("requests.jsonl should include the forced output-text question"));
    assert.strictEqual(gateRequest.type, "question", protocolFailure("forced output-text request should be a question"));
    assert.strictEqual(gateRequest.status, "resolved", protocolFailure("forced output-text question should be resolved"));

    const reviewRequest = requests.find((entry) =>
      entry.agent === "agent-live-all" &&
      entry.type === "review_request" &&
      entry.status === "resolved"
    );
    assert.ok(reviewRequest, protocolFailure("requests.jsonl should include a resolved all-live review_request"));
    assert.ok(
      requests.findIndex((entry) => entry.request_id === gateRequest.request_id) <
        requests.findIndex((entry) => entry.request_id === reviewRequest.request_id),
      protocolFailure("forced output-text question should be recorded before the final review_request")
    );

    const decisions = readJson(path.join(project.root, "coord", "decisions.json"));
    const gateDecision = decisions.find((entry) => entry.request_id === "agent-live-req-output-text");
    assert.ok(gateDecision, protocolFailure("decisions.json should include the forced output-text question"));
    assert.strictEqual(gateDecision.disposition, "approved", protocolFailure("forced output-text question should be approved"));
    const gateDecisionBeforeOutput = fs.statSync(outputPath).mtimeMs >= new Date(gateDecision.resolved_at).getTime();
    assert.ok(gateDecisionBeforeOutput, protocolFailure("live-worker-output.txt should be written after the output-text approval decision"));

    const audit = readJsonl(path.join(project.root, "coord", "decisions.jsonl"));
    const gateQuestionAudited = audit.some((entry) => entry.request_id === "agent-live-req-output-text");
    const finalReviewAudited = audit.some((entry) => entry.request_id === reviewRequest.request_id);
    assert.ok(gateQuestionAudited, protocolFailure("decisions.jsonl should audit the forced question"));
    assert.ok(finalReviewAudited, protocolFailure("decisions.jsonl should audit the final review request"));

    const summaryPath = path.join(project.root, "coord", "review-summary.txt");
    await waitFor(() => fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf-8") : false, {
      timeoutMs: 30 * 1000,
      intervalMs: 500,
    });

    cleanupLiveProcesses(project.root, loopPid);
    loopPid = null;

    return {
      provider: providerName,
      mixed_combo: isMixedTarget(providerName) ? selectedMixedCombo() : null,
      roles: liveRoleMappings(providerName),
      cli: roleProviderInfo(providerName, "worker").cli,
      reviewer: aliases.reviewer,
      review,
      gateRequest,
      gateDecision,
      reviewRequest,
      gateDecisionBeforeOutput,
      finalReviewAudited,
      outputPath,
    };
  } catch (err) {
    preserveArtifacts = true;
    if (isMixedTarget(providerName)) recordLiveFailure(project.root, providerName, err);
    throw err;
  } finally {
    cleanupLiveProcesses(project.root, loopPid);
    if (preserveArtifacts) {
      console.log(`Keeping live test artifacts: ${project.root}`);
    } else {
      project.cleanup();
    }
  }
}

function writeLiveProviderConfig(projectRoot, providerName) {
  const aliases = providerAliases(providerName);
  const roleConfig = buildLiveRoleConfig(projectRoot, providerName, configRoleNames(providerName, RUNTIME_ROLE_NAMES));
  const config = {
    default_cli: aliases.worker,
    orchestrator_cli: aliases.arbitrator,
    max_plan_review_iterations: 1,
    default_timeout_mins: 10,
    poll_min_ms: 1000,
    poll_max_ms: 3000,
    launch_dashboard: false,
    launch_review_terminal: false,
    reviewers: [
      {
        name: aliases.reviewer,
        cli: aliases.reviewer,
        review_focus: "Validate live lower-model reviewer output for a tiny single-worker decomposition plan.",
      },
    ],
    live_roles: roleConfig.live_roles,
    cli_templates: roleConfig.cli_templates,
    cli_health_checks: roleConfig.cli_health_checks,
  };
  if (isMixedTarget(providerName)) {
    config.mixed_combo = selectedMixedCombo();
  }

  writeRuntimeConfig(projectRoot, config);
  return config;
}

function writeAllLiveProviderConfig(projectRoot, providerName) {
  const aliases = providerAliases(providerName);
  const roleConfig = buildLiveRoleConfig(projectRoot, providerName, configRoleNames(providerName, RUNTIME_ROLE_NAMES));
  const config = {
    default_cli: aliases.worker,
    orchestrator_cli: aliases.arbitrator,
    max_plan_review_iterations: 1,
    default_timeout_mins: 10,
    default_progress_timeout_mins: 10,
    poll_min_ms: 250,
    poll_max_ms: 500,
    launch_dashboard: false,
    launch_review_terminal: false,
    reviewers: [
      {
        name: aliases.reviewer,
        cli: aliases.reviewer,
        review_focus: "Validate the all-live lower-model protocol test: reviewer, arbitrator, and worker all use provider CLIs.",
      },
    ],
    live_roles: roleConfig.live_roles,
    cli_templates: roleConfig.cli_templates,
    cli_health_checks: roleConfig.cli_health_checks,
  };
  if (isMixedTarget(providerName)) {
    config.mixed_combo = selectedMixedCombo();
  }

  writeRuntimeConfig(projectRoot, config);
  return config;
}

function writeMixedProviderConfig(projectRoot) {
  return writeAllLiveProviderConfig(projectRoot, MIXED_PROVIDER_TARGET);
}

function writeLiveWorkerConfig(projectRoot, providerName) {
  const aliases = providerAliases(providerName);
  const roleConfig = buildLiveRoleConfig(projectRoot, providerName, ["worker"]);
  const fakeArbitratorPath = writeFakeArbitrator(projectRoot);
  const fakeArbitrator = "fake-live-arbitrator";
  const config = {
    default_cli: aliases.worker,
    orchestrator_cli: fakeArbitrator,
    max_plan_review_iterations: 1,
    default_timeout_mins: 10,
    default_progress_timeout_mins: 10,
    poll_min_ms: 250,
    poll_max_ms: 500,
    launch_dashboard: false,
    launch_review_terminal: false,
    live_roles: roleConfig.live_roles,
    cli_templates: {
      ...roleConfig.cli_templates,
      [fakeArbitrator]: {
        cmd: process.execPath,
        args: [fakeArbitratorPath, { prompt_file: true }],
      },
    },
    cli_health_checks: {
      ...roleConfig.cli_health_checks,
      [fakeArbitrator]: `${process.execPath} --version`,
    },
  };

  writeRuntimeConfig(projectRoot, config);
  return config;
}

function writeRuntimeConfig(projectRoot, config) {
  const { live_roles: _liveRoles, mixed_combo: _mixedCombo, ...runtimeConfig } = config;
  fs.writeFileSync(
    path.join(projectRoot, "orchestrator.config.js"),
    `module.exports = ${JSON.stringify(runtimeConfig, null, 2)};\n`,
    "utf-8"
  );
}

function writeReviewerSmokeDraft(projectRoot) {
  const draftPath = path.join(projectRoot, "coord", "plan-reviews", "draft-plan-v1.json");
  const draft = {
    project: "Live lower-model reviewer smoke project",
    user_requirements: [
      "Exercise a lower-model reviewer through the real review-plan runner.",
      "Keep the task intentionally tiny and read-only.",
    ],
    constraints: [
      "Reviewer must not edit files or launch workers.",
      "The plan should remain single_worker because there is one output file.",
    ],
    candidate_execution_topology: {
      execution_mode: "single_worker",
      reason: "One worker owns one file and one validation command.",
      rejected_alternatives: [
        { execution_mode: "direct", reason: "The live test must exercise a reviewer role." },
        { execution_mode: "parallel", reason: "There are no independent boundaries." },
        { execution_mode: "phased", reason: "There is no shared foundation phase." },
      ],
      dependency_notes: ["No worker-to-worker dependencies."],
      shared_foundation_notes: ["No package or lockfile changes are needed."],
      mode_specific_decomposition: ["One worker writes live-worker-output.txt and requests review."],
    },
    shared_foundation_assumptions: ["README.md is read-only context."],
    foundation: { status: "not_required", paths: [], commit: "", owner: "" },
    known_risks: ["Live model output may fail JSON formatting and should be diagnosed from saved artifacts."],
    tasks: {
      "agent-live": {
        description: "Create live-worker-output.txt containing exactly live worker smoke ok.",
        allowed_paths: ["live-worker-output.txt"],
        forbidden_paths: ["coord/", "package.json"],
        read_first: ["README.md"],
        validation_command: [
          "node",
          "-e",
          "const fs=require('fs');process.exit(fs.readFileSync('live-worker-output.txt','utf8').trim()==='live worker smoke ok'?0:1)",
        ],
        sequencing_notes: ["Run after caller approval."],
      },
    },
  };

  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf-8");
  return draftPath;
}

function writeAllLiveDraft(projectRoot, providerName) {
  const draftPath = path.join(projectRoot, "coord", "plan-reviews", "draft-plan-v1.json");
  const draft = allLivePlan(providerName);
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf-8");
  return draftPath;
}

function writeArbitratorSmokeContext(projectRoot, providerName) {
  writeCoordBase(projectRoot, {
    project: `Live ${providerName} arbitrator smoke project`,
    chat_context: {
      summary: "Live lower-model arbitrator should resolve one deterministic worker question.",
    },
    execution_topology: {
      execution_mode: "single_worker",
      reason: "The seeded request belongs to one fake completed agent.",
      dependency_notes: [],
    },
    requirements: ["Resolve the staged question request through the real arbitration path."],
    constraints: ["Every pending request must be approved or rejected."],
    tasks: {
      "agent-live-arbitrator": {
        description: "Ask for approval of the exact live worker smoke output text.",
        allowed_paths: ["live-worker-output.txt"],
        validation_command: null,
      },
    },
  });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(projectRoot, "coord", "agents.json"), `${JSON.stringify({
    "agent-live-arbitrator": {
      task: "Seeded request owner for live arbitrator smoke.",
      status: "completed",
      worktree: projectRoot,
      cli: providerAliases(providerName).worker,
      pid: null,
      started_at: now,
      current_started_at: now,
      last_spawned_at: now,
      base_ref: "HEAD",
      restart_count: 0,
    },
  }, null, 2)}\n`, "utf-8");
}

function writeWorkerSmokeContext(projectRoot, providerName) {
  writeCoordBase(projectRoot, {
    project: `Live ${providerName} worker smoke project`,
    chat_context: {
      summary: "Live lower-model worker should complete one simple file-writing task.",
    },
    execution_topology: {
      execution_mode: "single_worker",
      reason: "One worker owns one output file and one validation command.",
      dependency_notes: [],
    },
    requirements: ["Create the exact output file and request review."],
    constraints: ["Only write live-worker-output.txt."],
    tasks: {
      "agent-live-worker": {
        description: [
          "Create a file named live-worker-output.txt in your worktree containing exactly:",
          "live worker smoke ok",
          "Do not add any other text to that file.",
          "After creating it, submit a review_request to coord/requests/ using the documented atomic tmp-to-json protocol.",
          "In the review_request content, mention live-worker-output.txt and the validation command result if you ran it.",
        ].join("\n"),
        cli: providerAliases(providerName).worker,
        allowed_paths: ["live-worker-output.txt"],
        forbidden_paths: ["coord/", "package.json", "README.md"],
        read_first: ["README.md", "coord/DECISIONS.md", "coord/context.json"],
        validation_command: liveWorkerValidationCommand(),
        sequencing_notes: ["No dependencies; run immediately."],
      },
    },
  });
}

function writeAllLiveContext(projectRoot, providerName) {
  const plan = allLivePlan(providerName);
  writeCoordBase(projectRoot, {
    project: plan.project,
    chat_context: {
      summary: "All-live lower-model test: reviewer, arbitrator, and worker use provider CLIs.",
      forced_request_id: "agent-live-req-output-text",
      expected_output_text: "live worker smoke ok",
    },
    execution_topology: plan.candidate_execution_topology,
    requirements: plan.user_requirements,
    constraints: plan.constraints,
    tasks: plan.tasks,
  }, {
    decisions: [
      "- This is the Stage 6 all-live lower-model smoke test.",
      "- When `agent-live-all` submits `agent-live-req-output-text` asking to write `live-worker-output.txt` with exactly `live worker smoke ok`, approve the request.",
      "- The worker must not write `live-worker-output.txt` before that approval exists in `coord/decisions.json` or `coord/decisions.jsonl`.",
      "- When `agent-live-all` later submits a `review_request` after creating `live-worker-output.txt`, approve the request and include an `end_agent` action so validation can complete the run.",
      "- The only intended worker-owned output file is `live-worker-output.txt`.",
    ],
    callerContext: [
      "This all-live test intentionally forces a worker question before the file write.",
      "The live arbitrator should approve the exact text request and later end the agent after the final review_request.",
    ],
  });
}

function configRoleNames(providerName, runtimeRoles) {
  return isMixedTarget(providerName)
    ? Array.from(new Set(["planner", ...runtimeRoles]))
    : runtimeRoles;
}

function buildLiveRoleConfig(projectRoot, providerName, roles) {
  const config = {
    live_roles: {},
    cli_templates: {},
    cli_health_checks: {},
  };

  for (const role of roles) {
    const alias = providerAliases(providerName)[role];
    const provider = roleProviderInfo(providerName, role);
    const template = liveRoleTemplate(projectRoot, providerName, role);
    const model = roleModel(providerName, role);

    config.live_roles[role] = {
      alias,
      cli: alias,
      provider: roleProviderName(providerName, role),
      provider_cli: provider.cli,
      model,
      cli_template: template,
      health_check: provider.healthCheck,
    };
    config.cli_templates[alias] = template;
    config.cli_health_checks[alias] = provider.healthCheck;
  }

  return config;
}

function liveRoleTemplate(projectRoot, providerName, role) {
  const provider = roleProviderInfo(providerName, role);
  const coordDir = path.join(projectRoot, "coord");
  fs.mkdirSync(coordDir, { recursive: true });
  return provider.template(roleModel(providerName, role), {
    includeCoordDir: coordDir,
    role,
  });
}

function allLivePlan(providerName) {
  return {
    project: `Live ${providerName} all-live smoke project`,
    user_requirements: [
      "Exercise lower-model reviewer, arbitrator, and worker roles in one run.",
      "Force the worker to request approval for the exact output text before writing the file.",
      "Complete by writing live-worker-output.txt and submitting a final review_request.",
    ],
    constraints: [
      "Worker must not write live-worker-output.txt before approval for agent-live-req-output-text is recorded.",
      "Worker may only edit live-worker-output.txt.",
      "Arbitrator must resolve every pending request explicitly.",
    ],
    candidate_execution_topology: {
      execution_mode: "single_worker",
      reason: "One worker owns one output file; the reviewer and arbitrator are role checks, not independent implementation workers.",
      rejected_alternatives: [
        { execution_mode: "direct", reason: "The test must exercise worker and arbitrator roles through the live orchestration path." },
        { execution_mode: "parallel", reason: "There is only one implementation boundary." },
        { execution_mode: "phased", reason: "No shared foundation phase is required." },
      ],
      dependency_notes: ["Worker progress depends on the arbitrator decision for agent-live-req-output-text."],
      shared_foundation_notes: ["No package or lockfile changes are needed."],
      mode_specific_decomposition: ["One worker asks approval, waits, writes live-worker-output.txt, and requests final review."],
    },
    shared_foundation_assumptions: ["README.md and coord files are read-only context except for documented request staging."],
    foundation: { status: "not_required", paths: [], commit: "", owner: "" },
    known_risks: ["Live model behavior may fail JSON formatting, waiting, or exact file content requirements."],
    tasks: {
      "agent-live-all": {
        description: [
          "This is an all-live protocol smoke test. Follow these steps exactly.",
          "",
          "Step 1: Before creating live-worker-output.txt, submit a medium-priority question request to coord/requests/ using the documented atomic tmp-to-json protocol.",
          "The request JSON MUST have request_id \"agent-live-req-output-text\", agent \"agent-live-all\", type \"question\", priority \"medium\", status \"pending\", and content asking approval to write live-worker-output.txt with exactly: live worker smoke ok",
          "",
          "Step 2: After staging that request, wait until coord/decisions.json or coord/decisions.jsonl contains request_id \"agent-live-req-output-text\" with disposition \"approved\".",
          "Do not create live-worker-output.txt before the approval is visible. Poll the decision files if needed.",
          "If the request is rejected, do not write the file; submit a high-priority follow-up question explaining the rejection and stop.",
          "",
          "Step 3: After approval, create live-worker-output.txt containing exactly one line: live worker smoke ok",
          "Do not add any other text to that file.",
          "",
          "Step 4: Submit a final review_request to coord/requests/ using the documented atomic tmp-to-json protocol.",
          "The final review_request content should mention the approval request id, live-worker-output.txt, and the validation command result if you ran it.",
          "",
          "Step 5: After submitting the final review_request, wait for the orchestrator to end the agent.",
        ].join("\n"),
        cli: providerAliases(providerName).worker,
        allowed_paths: ["live-worker-output.txt"],
        forbidden_paths: ["coord/context.json", "coord/DECISIONS.md", "coord/CALLER_CONTEXT.md", "package.json", "README.md"],
        read_first: ["README.md", "coord/DECISIONS.md", "coord/CALLER_CONTEXT.md", "coord/context.json"],
        validation_command: liveWorkerValidationCommand(),
        sequencing_notes: ["Ask for approval first; continue only after approved decision is visible."],
      },
    },
  };
}

function writeCoordBase(projectRoot, context, options = {}) {
  const coordDir = path.join(projectRoot, "coord");
  fs.mkdirSync(path.join(coordDir, "requests"), { recursive: true });
  fs.mkdirSync(path.join(coordDir, "progress"), { recursive: true });
  fs.mkdirSync(path.join(coordDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(coordDir, "context.json"), `${JSON.stringify({
    ...context,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf-8");
  const decisions = options.decisions || [
    "- Live smoke tests must keep file ownership narrow and explicit.",
    "- The exact worker output text is `live worker smoke ok`.",
  ];
  fs.writeFileSync(path.join(coordDir, "DECISIONS.md"), [
    "# Decisions",
    "",
    ...decisions,
    "",
  ].join("\n"), "utf-8");
  const callerContext = options.callerContext || [
    "This is an opt-in live lower-model test. Prefer deterministic, minimal decisions.",
  ];
  fs.writeFileSync(path.join(coordDir, "CALLER_CONTEXT.md"), [
    "# Caller Context",
    "",
    ...callerContext,
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(coordDir, "requests.jsonl"), "", "utf-8");
  fs.writeFileSync(path.join(coordDir, "decisions.json"), "[]\n", "utf-8");
  fs.writeFileSync(path.join(coordDir, "decisions.jsonl"), "", "utf-8");
  fs.writeFileSync(path.join(coordDir, "agents.json"), "{}\n", "utf-8");
}

function stageQuestionRequest(projectRoot, request) {
  const requestsDir = path.join(projectRoot, "coord", "requests");
  fs.mkdirSync(requestsDir, { recursive: true });
  const tmpFile = path.join(requestsDir, `${request.request_id}.tmp`);
  const finalFile = path.join(requestsDir, `${request.request_id}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(request, null, 2), "utf-8");
  fs.renameSync(tmpFile, finalFile);
  return request;
}

function liveSkipReason(providerName) {
  if (!isKnownLiveTarget(providerName)) {
    return `Unknown live provider '${providerName}'.`;
  }
  if (process.env.RUN_LIVE_MODEL_TESTS !== "1") {
    return "Set RUN_LIVE_MODEL_TESTS=1 to run live model tests.";
  }
  if (isMixedTarget(providerName) && process.env.RUN_MIXED_LIVE_TESTS !== "1") {
    return "Set RUN_MIXED_LIVE_TESTS=1 to run mixed-provider live model tests.";
  }
  const selectedProvider = process.env.LIVE_PROVIDER;
  if (selectedProvider && selectedProvider !== "all" && selectedProvider !== providerName) {
    return `LIVE_PROVIDER=${selectedProvider} does not select ${providerName}.`;
  }
  try {
    if (isMixedTarget(providerName)) selectedMixedCombo();
    for (const role of liveMetadataRoles(providerName)) roleProviderName(providerName, role);
  } catch (err) {
    return err.message;
  }
  return "";
}

function probeProviderCli(providerName) {
  const provider = providerInfo(providerName);
  const result = spawnSync(provider.cli, ["--version"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error) {
    return { ok: false, message: `${provider.cli} is not runnable: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: `${provider.cli} --version failed with exit ${result.status}: ${(result.stderr || result.stdout || "").trim()}`,
    };
  }
  return { ok: true, output: (result.stdout || result.stderr || "").trim() };
}

function probeLiveRoleClis(providerName, roles) {
  const probed = new Set();
  for (const role of roles) {
    let roleProvider;
    try {
      roleProvider = roleProviderName(providerName, role);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    if (probed.has(roleProvider)) continue;
    probed.add(roleProvider);
    const probe = probeProviderCli(roleProvider);
    if (!probe.ok) {
      return {
        ok: false,
        message: `${role} provider ${roleProvider}: ${probe.message}`,
      };
    }
  }
  return { ok: true };
}

function writeFakeArbitrator(projectRoot) {
  const file = path.join(projectRoot, "fake-live-arbitrator.js");
  fs.writeFileSync(file, [
    "#!/usr/bin/env node",
    "\"use strict\";",
    "const fs = require(\"node:fs\");",
    "const prompt = fs.readFileSync(process.argv[2], \"utf-8\");",
    "if (!prompt.includes(\"system orchestrator for a multi-agent project\")) {",
    "  process.stdout.write(JSON.stringify({ approved: [], rejected: [], actions: [] }));",
    "  process.exit(0);",
    "}",
    "const requests = parseRequests(prompt);",
    "const approved = requests.map((request) => ({",
    "  request_id: request.request_id,",
    "  decision: request.type === \"review_request\" ? \"Completion approved by fake live-test arbitrator.\" : \"Request approved by fake live-test arbitrator.\",",
    "  reason: \"The live worker smoke test keeps ownership narrow and validation is delegated to the configured command.\"",
    "}));",
    "const actions = requests",
    "  .filter((request) => request.type === \"review_request\")",
    "  .map((request) => ({ type: \"end_agent\", agent: request.agent }));",
    "process.stdout.write(JSON.stringify({ approved, rejected: [], actions }));",
    "function parseRequests(value) {",
    "  const start = value.indexOf(\"## New Requests from Agents\");",
    "  const end = value.indexOf(\"## Your Responsibilities\");",
    "  const section = value.slice(start, end === -1 ? undefined : end);",
    "  const match = section.match(/\\[[\\s\\S]*\\]/);",
    "  return match ? JSON.parse(match[0]) : [];",
    "}",
  ].join("\n") + "\n", "utf-8");
  return file;
}

function providerAliases(providerName) {
  return {
    planner: `${providerName}-live-planner`,
    worker: `${providerName}-live-worker`,
    arbitrator: `${providerName}-live-arbitrator`,
    reviewer: `${providerName}-live-reviewer`,
  };
}

function writeLiveSession(projectRoot, providerName, test) {
  const coordDir = path.join(projectRoot, "coord");
  fs.mkdirSync(coordDir, { recursive: true });
  const tailCommand = liveTailCommand(projectRoot, providerName, test);
  const roles = liveRoleMappings(providerName);
  const session = {
    session_id: path.basename(projectRoot),
    provider: providerName,
    test,
    workspace: projectRoot,
    created_at: new Date().toISOString(),
    roles,
    models: Object.fromEntries(Object.entries(roles).map(([role, mapping]) => [role, mapping.model])),
    inspect_command: `node ${path.join(repoRoot(), "scripts", "inspect-live-test.js")} ${projectRoot}`,
    tail_command: tailCommand,
  };
  if (isMixedTarget(providerName)) {
    session.mixed_combo = selectedMixedCombo();
  }
  fs.writeFileSync(path.join(coordDir, "live-test-session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf-8");
  console.log(`[live-harness] Session ID: ${session.session_id}`);
  console.log(`[live-harness] Inspect: ${session.inspect_command}`);
  console.log(`[live-harness] Tail: ${session.tail_command}`);
  return session;
}

function liveTailCommand(projectRoot, providerName, test) {
  const coordDir = path.join(projectRoot, "coord");
  const aliases = providerAliases(providerName);
  const files = [];

  if (test === "reviewer" || test === "all-live") {
    files.push(path.join(coordDir, "plan-reviews", "iteration-1", `${aliases.reviewer}.md`));
  }
  if (test === "arbitrator" || test === "worker" || test === "all-live") {
    files.push(path.join(coordDir, "orchestrator.log"));
  }
  if (test === "worker") {
    files.push(path.join(coordDir, "logs", "agent-live-worker.log"));
  }
  if (test === "all-live") {
    files.push(path.join(coordDir, "logs", "agent-live-all.log"));
  }

  return `tail -F ${files.map(shellQuote).join(" ")}`;
}

function updateLiveSession(projectRoot, patch) {
  const sessionPath = path.join(projectRoot, "coord", "live-test-session.json");
  let session = {};
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
  } catch (_) {}
  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify({ ...session, ...patch, updated_at: new Date().toISOString() }, null, 2)}\n`,
    "utf-8"
  );
}

function createLiveProject(providerName, prefix) {
  const tmpDir = liveTempDir(providerName);
  return createTempProject(prefix, tmpDir ? { tmpDir } : {});
}

function liveTempDir(providerName) {
  if (process.env.LIVE_TEST_TMPDIR) return process.env.LIVE_TEST_TMPDIR;
  if (providerName === "opencode" && fs.existsSync("/private/tmp")) return "/private/tmp";
  if (isMixedTarget(providerName) && fs.existsSync("/private/tmp")) {
    try {
      if (liveMetadataRoles(providerName).some((role) => roleProviderName(providerName, role) === "opencode")) {
        return "/private/tmp";
      }
    } catch (_) {}
  }
  return "";
}

function roleModel(providerName, role) {
  validateRoleName(role);
  if (isMixedTarget(providerName)) {
    const mixedOverride = envValue(`LIVE_MIXED_${role.toUpperCase()}_MODEL`);
    if (mixedOverride) return mixedOverride;
    return providerRoleModel(roleProviderName(providerName, role), role);
  }
  return providerRoleModel(providerName, role);
}

function providerRoleModel(providerName, role) {
  const provider = providerInfo(providerName);
  const prefix = provider.envPrefix;
  return envValue(`LIVE_${prefix}_${role.toUpperCase()}_MODEL`) ||
    envValue(`LIVE_${prefix}_MODEL`) ||
    provider.defaultModel;
}

function liveRoleMappings(providerName, roles = liveMetadataRoles(providerName)) {
  const aliases = providerAliases(providerName);
  return Object.fromEntries(roles.map((role) => {
    const roleProvider = roleProviderName(providerName, role);
    const provider = providerInfo(roleProvider);
    return [role, {
      alias: aliases[role],
      cli: aliases[role],
      provider: roleProvider,
      provider_cli: provider.cli,
      model: roleModel(providerName, role),
    }];
  }));
}

function roleProviderInfo(providerName, role) {
  return providerInfo(roleProviderName(providerName, role));
}

function roleProviderName(providerName, role) {
  validateRoleName(role);
  if (isMixedTarget(providerName)) {
    const envName = `LIVE_MIXED_${role.toUpperCase()}_PROVIDER`;
    const configured = envValue(envName);
    const roleProvider = configured ? configured.toLowerCase() : MIXED_ROLE_COMBOS[selectedMixedCombo()][role].provider;
    if (!PROVIDERS[roleProvider]) {
      throw new Error(`${envName} must be one of: ${Object.keys(PROVIDERS).join(", ")}.`);
    }
    return roleProvider;
  }
  providerInfo(providerName);
  return providerName;
}

function selectedMixedCombo() {
  const combo = envValue("LIVE_MIXED_COMBO") || DEFAULT_MIXED_COMBO;
  if (!MIXED_ROLE_COMBOS[combo]) {
    throw new Error(`LIVE_MIXED_COMBO must be one of: ${Object.keys(MIXED_ROLE_COMBOS).join(", ")}.`);
  }
  return combo;
}

function roleFailureDetails(providerName, roles) {
  return roles.map((role) =>
    `${role}: alias=${providerAliases(providerName)[role]} provider=${roleProviderName(providerName, role)} model=${roleModel(providerName, role)}`
  );
}

function liveMetadataRoles(providerName) {
  return isMixedTarget(providerName) ? LIVE_ROLE_NAMES : RUNTIME_ROLE_NAMES;
}

function isKnownLiveTarget(providerName) {
  return isMixedTarget(providerName) || Boolean(PROVIDERS[providerName]);
}

function isMixedTarget(providerName) {
  return providerName === MIXED_PROVIDER_TARGET;
}

function validateRoleName(role) {
  if (!LIVE_ROLE_NAMES.includes(role)) {
    throw new Error(`Unknown live role '${role}'.`);
  }
}

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

function liveTimeoutMs(role, fallback) {
  const specific = process.env[`LIVE_${role.toUpperCase()}_TIMEOUT_MS`];
  const general = process.env.LIVE_TEST_TIMEOUT_MS;
  const value = Number(specific || general || fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function liveWorkerValidationCommand() {
  return [
    "node",
    "-e",
    "const fs=require('fs');process.exit(fs.readFileSync('live-worker-output.txt','utf8').trim()==='live worker smoke ok'?0:1)",
  ];
}

function cleanupLiveProcesses(projectRoot, loopPid = null) {
  cleanupProcess(loopPid);

  const lockPidFile = path.join(projectRoot, "coord", "orchestrator.instance.lock", "pid");
  if (fs.existsSync(lockPidFile)) {
    try {
      cleanupProcess(Number(fs.readFileSync(lockPidFile, "utf-8")));
    } catch {}
  }

  const agentsPath = path.join(projectRoot, "coord", "agents.json");
  if (fs.existsSync(agentsPath)) {
    try {
      const agents = readJson(agentsPath);
      for (const agent of Object.values(agents)) {
        cleanupProcess(agent && agent.pid);
      }
    } catch {}
  }

  try {
    fs.rmSync(path.join(projectRoot, "coord", "orchestrator.instance.lock"), { recursive: true, force: true });
  } catch {}
}

function liveFailureMessage(projectRoot, providerName, reason, agentName = "agent-live-worker", roles = ["worker"]) {
  const details = [
    `${providerName} live smoke failed: ${reason}`,
    `roles:\n${roleFailureDetails(providerName, roles).join("\n")}`,
    `artifacts: ${projectRoot}`,
  ];
  const logPath = path.join(projectRoot, "coord", "orchestrator.log");
  if (fs.existsSync(logPath)) {
    details.push(`orchestrator.log:\n${tailText(logPath, 120)}`);
  }
  const workerLog = path.join(projectRoot, "coord", "logs", `${agentName}.log`);
  if (fs.existsSync(workerLog)) {
    details.push(`worker log:\n${tailText(workerLog, 120)}`);
  }
  return details.join("\n\n");
}

function processResultText(result) {
  return [
    result?.stdout || "",
    result?.stderr || "",
    result?.error?.message || "",
  ].join("\n");
}

function transientProviderSkipReason(providerName, roles, text) {
  if (process.env.LIVE_SKIP_TRANSIENT_PROVIDER_ERRORS === "0") return "";
  const value = String(text || "");
  const match = value.match(/\b(429|rate[ -]?limit(?:ed)?|too many requests|resource_exhausted|quota(?: exceeded)?|insufficient_quota|over quota|billing hard limit|temporarily unavailable|try again later)\b/i);
  if (!match) return "";
  return [
    `${providerName} live smoke skipped due to transient provider capacity/quota signal: ${match[0]}`,
    ...roleFailureDetails(providerName, roles),
    "Set LIVE_SKIP_TRANSIENT_PROVIDER_ERRORS=0 to treat this condition as a failure.",
  ].join("\n");
}

function transientProviderSkipReasonFromArtifacts(projectRoot, providerName, roles) {
  return transientProviderSkipReason(providerName, roles, liveArtifactDiagnosticText(projectRoot));
}

function liveArtifactDiagnosticText(projectRoot) {
  const coordDir = path.join(projectRoot, "coord");
  const parts = [];
  for (const file of [
    path.join(coordDir, "orchestrator.log"),
    path.join(coordDir, "review-summary.txt"),
  ]) {
    if (fs.existsSync(file)) parts.push(tailText(file, 200));
  }
  const logsDir = path.join(coordDir, "logs");
  if (fs.existsSync(logsDir)) {
    for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".log")) {
        parts.push(tailText(path.join(logsDir, entry.name), 200));
      }
    }
  }
  return parts.join("\n");
}

function recordLiveFailure(projectRoot, providerName, err) {
  try {
    updateLiveSession(projectRoot, {
      preserved_artifacts: true,
      failure: {
        message: err && err.message ? err.message : String(err),
        roles: liveRoleMappings(providerName),
      },
    });
  } catch (_) {}
}

function tailText(file, maxLines) {
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch (err) {
    return `Unable to read ${file}: ${err.message}`;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function assertValidReviewerJson(value, reviewerName, iteration) {
  assert.equal(value.iteration, iteration);
  assert.equal(value.reviewer, reviewerName);
  assert.equal(typeof value.summary, "string");
  for (const field of REQUIRED_REVIEWER_ARRAY_FIELDS) {
    assert.ok(Array.isArray(value[field]), `${field} must be an array`);
  }
}

function providerInfo(providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Unknown live provider: ${providerName}`);
  return provider;
}

function skip(t, reason) {
  if (t && typeof t.skip === "function") t.skip(reason);
  return { skipped: true, reason };
}

module.exports = {
  DEFAULT_MIXED_COMBO,
  LIVE_ROLE_NAMES,
  MIXED_PROVIDER_TARGET,
  MIXED_ROLE_COMBOS,
  MIXED_ROLE_DEFAULTS,
  PROVIDERS,
  assertValidReviewerJson,
  liveRoleMappings,
  liveSkipReason,
  liveTailCommand,
  liveTempDir,
  probeProviderCli,
  probeLiveRoleClis,
  providerAliases,
  roleProviderName,
  roleModel,
  runAllLiveSmoke,
  selectedMixedCombo,
  transientProviderSkipReason,
  runLiveArbitratorSmoke,
  runLiveReviewerSmoke,
  runLiveWorkerSmoke,
  writeAllLiveProviderConfig,
  writeLiveProviderConfig,
  writeLiveWorkerConfig,
  writeMixedProviderConfig,
  writeReviewerSmokeDraft,
};
