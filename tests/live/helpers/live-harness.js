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
const reviewPlanPath = path.join(repoRoot(), "scripts", "review-plan.js");

const PROVIDERS = {
  codex: {
    envPrefix: "CODEX",
    cli: "codex",
    defaultModel: "gpt-5.1-codex-mini",
    alternateModel: "gpt-5-mini",
    healthCheck: "codex --version",
    template(model) {
      return {
        cmd: "codex",
        args: ["exec", "--model", model, "--dangerously-bypass-approvals-and-sandbox", { prompt_text: true }],
      };
    },
  },
  claude: {
    envPrefix: "CLAUDE",
    cli: "claude",
    defaultModel: "claude-sonnet-4-6",
    healthCheck: "claude --version",
    template(model) {
      return {
        cmd: "claude",
        args: ["-p", { prompt_text: true }, "--dangerously-skip-permissions", "--model", model],
      };
    },
  },
  gemini: {
    envPrefix: "GEMINI",
    cli: "gemini",
    defaultModel: "gemini-2.5-flash",
    healthCheck: "gemini --version",
    template(model) {
      return {
        cmd: "gemini",
        args: ["--prompt", { prompt_text: true }, "--yolo", "--model", model],
      };
    },
  },
};

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

  const provider = providerInfo(providerName);
  const probe = probeProviderCli(providerName);
  if (!probe.ok) return skip(t, probe.message);

  const project = createTempProject(`live-${providerName}-reviewer-`);
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
        `model: ${roleModel(providerName, "reviewer")}`,
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
      cli: provider.cli,
      model: roleModel(providerName, "reviewer"),
      reviewer: aliases.reviewer,
      review,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (err) {
    preserveArtifacts = true;
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

  const provider = providerInfo(providerName);
  const probe = probeProviderCli(providerName);
  if (!probe.ok) return skip(t, probe.message);

  const project = createTempProject(`live-${providerName}-arbitrator-`);
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
        `model: ${roleModel(providerName, "arbitrator")}`,
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
      cli: provider.cli,
      model: roleModel(providerName, "arbitrator"),
      request: resolvedRequest,
      decision,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (err) {
    preserveArtifacts = true;
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

  const provider = providerInfo(providerName);
  const probe = probeProviderCli(providerName);
  if (!probe.ok) return skip(t, probe.message);

  const project = createTempProject(`live-${providerName}-worker-`);
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
        `model: ${roleModel(providerName, "worker")}`,
        `stdout:\n${launchResult.stdout || "(empty)"}`,
        `stderr:\n${launchResult.stderr || "(empty)"}`,
      ].join("\n\n")
    );

    const loopPidMatch = launchResult.stdout.match(/Orchestrator loop backgrounded \(PID:\s*(\d+)\)/);
    loopPid = loopPidMatch ? Number(loopPidMatch[1]) : null;

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
      cli: provider.cli,
      model: roleModel(providerName, "worker"),
      reviewer: aliases.reviewer,
      outputPath,
      reviewRequest,
    };
  } catch (err) {
    preserveArtifacts = true;
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
  const provider = providerInfo(providerName);
  const aliases = providerAliases(providerName);
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
    cli_templates: {
      [aliases.worker]: provider.template(roleModel(providerName, "worker")),
      [aliases.arbitrator]: provider.template(roleModel(providerName, "arbitrator")),
      [aliases.reviewer]: provider.template(roleModel(providerName, "reviewer")),
    },
    cli_health_checks: {
      [aliases.worker]: provider.healthCheck,
      [aliases.arbitrator]: provider.healthCheck,
      [aliases.reviewer]: provider.healthCheck,
    },
  };

  fs.writeFileSync(
    path.join(projectRoot, "orchestrator.config.js"),
    `module.exports = ${JSON.stringify(config, null, 2)};\n`,
    "utf-8"
  );
  return config;
}

function writeLiveWorkerConfig(projectRoot, providerName) {
  const provider = providerInfo(providerName);
  const aliases = providerAliases(providerName);
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
    cli_templates: {
      [aliases.worker]: provider.template(roleModel(providerName, "worker")),
      [fakeArbitrator]: {
        cmd: process.execPath,
        args: [fakeArbitratorPath, { prompt_file: true }],
      },
    },
    cli_health_checks: {
      [aliases.worker]: provider.healthCheck,
      [fakeArbitrator]: `${process.execPath} --version`,
    },
  };

  fs.writeFileSync(
    path.join(projectRoot, "orchestrator.config.js"),
    `module.exports = ${JSON.stringify(config, null, 2)};\n`,
    "utf-8"
  );
  return config;
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

function writeCoordBase(projectRoot, context) {
  const coordDir = path.join(projectRoot, "coord");
  fs.mkdirSync(path.join(coordDir, "requests"), { recursive: true });
  fs.mkdirSync(path.join(coordDir, "progress"), { recursive: true });
  fs.mkdirSync(path.join(coordDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(coordDir, "context.json"), `${JSON.stringify({
    ...context,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf-8");
  fs.writeFileSync(path.join(coordDir, "DECISIONS.md"), [
    "# Decisions",
    "",
    "- Live smoke tests must keep file ownership narrow and explicit.",
    "- The exact worker output text is `live worker smoke ok`.",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(coordDir, "CALLER_CONTEXT.md"), [
    "# Caller Context",
    "",
    "This is an opt-in live lower-model test. Prefer deterministic, minimal decisions.",
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
  if (!PROVIDERS[providerName]) {
    return `Unknown live provider '${providerName}'.`;
  }
  if (process.env.RUN_LIVE_MODEL_TESTS !== "1") {
    return "Set RUN_LIVE_MODEL_TESTS=1 to run live model tests.";
  }
  const selectedProvider = process.env.LIVE_PROVIDER;
  if (selectedProvider && selectedProvider !== "all" && selectedProvider !== providerName) {
    return `LIVE_PROVIDER=${selectedProvider} does not select ${providerName}.`;
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
    worker: `${providerName}-live-worker`,
    arbitrator: `${providerName}-live-arbitrator`,
    reviewer: `${providerName}-live-reviewer`,
  };
}

function roleModel(providerName, role) {
  const provider = providerInfo(providerName);
  const prefix = provider.envPrefix;
  return process.env[`LIVE_${prefix}_${role.toUpperCase()}_MODEL`] ||
    process.env[`LIVE_${prefix}_MODEL`] ||
    provider.defaultModel;
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

function liveFailureMessage(projectRoot, providerName, reason) {
  const details = [
    `${providerName} live smoke failed: ${reason}`,
    `artifacts: ${projectRoot}`,
  ];
  const logPath = path.join(projectRoot, "coord", "orchestrator.log");
  if (fs.existsSync(logPath)) {
    details.push(`orchestrator.log:\n${tailText(logPath, 120)}`);
  }
  const workerLog = path.join(projectRoot, "coord", "logs", "agent-live-worker.log");
  if (fs.existsSync(workerLog)) {
    details.push(`worker log:\n${tailText(workerLog, 120)}`);
  }
  return details.join("\n\n");
}

function tailText(file, maxLines) {
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch (err) {
    return `Unable to read ${file}: ${err.message}`;
  }
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
  PROVIDERS,
  assertValidReviewerJson,
  liveSkipReason,
  probeProviderCli,
  providerAliases,
  roleModel,
  runLiveArbitratorSmoke,
  runLiveReviewerSmoke,
  runLiveWorkerSmoke,
  writeLiveProviderConfig,
  writeLiveWorkerConfig,
  writeReviewerSmokeDraft,
};
