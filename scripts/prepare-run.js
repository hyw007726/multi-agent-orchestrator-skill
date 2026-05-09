#!/usr/bin/env node
"use strict";

/**
 * Guided starter-session wrapper.
 *
 * Default mode:
 *   preflight -> bootstrap when needed -> draft-plan -> stop for caller review.
 *
 * Approval mode:
 *   materialize approved draft -> validate context -> print launch command.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

if (require.main === module) {
  try {
    const code = runPrepareRun(process.argv.slice(2), process.cwd());
    process.exitCode = code;
  } catch (err) {
    console.error(`prepare-run failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function runPrepareRun(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  return args.approveDraft ? runApprovalMode(args, cwd) : runDraftMode(args, cwd);
}

function runDraftMode(args, cwd) {
  if (!args.project) {
    throw new Error("--project is required unless --approve-draft is used.");
  }
  if (!args.task && !args.taskFile) {
    throw new Error("--task or --task-file is required unless --approve-draft is used.");
  }
  if (args.task && args.taskFile) {
    throw new Error("Use either --task or --task-file, not both.");
  }

  const coordDir = resolveFrom(cwd, args.coordDir);
  const contextPath = path.join(coordDir, "context.json");
  const draftPlanPath = path.join(coordDir, "plan-reviews", "draft-plan-v1.json");

  console.log("Prepare-run draft stage");
  console.log(`Project: ${args.project}`);
  console.log(`Coord directory: ${path.relative(cwd, coordDir) || "."}`);
  console.log("");

  runStep("Preflight configured CLIs", [
    path.join(__dirname, "preflight.js"),
    ...(args.skipPreflightAuth ? ["--skip-auth"] : []),
  ], cwd);

  if (fs.existsSync(contextPath) && !args.force) {
    console.log(`\n[skip] Bootstrap: ${path.relative(cwd, contextPath)} already exists. Pass --force to re-bootstrap.`);
  } else {
    const bootstrapArgs = [
      path.join(__dirname, "bootstrap.js"),
      "--project", args.project,
      "--coord", args.coordDir,
    ];
    appendOptionalValue(bootstrapArgs, "--requirements", args.requirements);
    appendOptionalValue(bootstrapArgs, "--constraints", args.constraints);
    appendOptionalValue(bootstrapArgs, "--chat-context", args.chatContext);
    runStep("Bootstrap coordination files", bootstrapArgs, cwd);
  }

  const draftArgs = [
    path.join(__dirname, "draft-plan.js"),
    "--project", args.project,
    "--coord", args.coordDir,
    "--timeout-ms", String(args.timeoutMs),
  ];
  if (args.taskFile) draftArgs.push("--task-file", args.taskFile);
  else draftArgs.push("--task", args.task);
  appendOptionalValue(draftArgs, "--repo-scan-summary", args.repoScanSummary);
  if (args.force) draftArgs.push("--force");
  runStep("Draft initial decomposition", draftArgs, cwd);

  console.log("");
  console.log("Prepare-run stopped for caller approval.");
  console.log(`Review and edit: ${path.relative(cwd, draftPlanPath)}`);
  console.log("");
  console.log("Optional plan review:");
  console.log(`  node ${path.join(__dirname, "review-plan.js")} --iteration 1 --draft-plan ${path.relative(cwd, draftPlanPath)} --coord ${args.coordDir}`);
  console.log("");
  console.log("After the caller approves the draft:");
  console.log(`  node ${path.join(__dirname, "prepare-run.js")} --approve-draft --draft-plan ${path.relative(cwd, draftPlanPath)} --coord ${args.coordDir}`);
  console.log("");
  console.log("The approval step will materialize context.json, DECISIONS.md, and CALLER_CONTEXT.md, then validate context.json.");
  return 0;
}

function runApprovalMode(args, cwd) {
  if (!args.draftPlan) {
    throw new Error("--draft-plan is required with --approve-draft.");
  }

  const coordDir = resolveFrom(cwd, args.coordDir);
  const contextPath = path.join(coordDir, "context.json");

  console.log("Prepare-run approval stage");
  console.log(`Draft plan: ${args.draftPlan}`);
  console.log(`Coord directory: ${path.relative(cwd, coordDir) || "."}`);
  console.log("");

  const materializeArgs = [
    path.join(__dirname, "materialize-plan.js"),
    "--draft-plan", args.draftPlan,
    "--coord", args.coordDir,
  ];
  if (args.force) materializeArgs.push("--force");
  runStep("Materialize approved draft", materializeArgs, cwd);

  runStep("Validate materialized context", [
    path.join(__dirname, "validate-context.js"),
    "--coord", args.coordDir,
  ], cwd);

  const context = readOptionalJson(contextPath) || {};
  console.log("");
  console.log("Prepare-run approval stage complete.");
  if (context.execution_topology?.execution_mode === "direct") {
    console.log("Execution topology is direct; keep the work in the caller session and do not launch workers.");
  } else {
    console.log("Final launch command:");
    console.log(`  node ${path.join(__dirname, "launch-all.js")} --coord ${args.coordDir}`);
  }
  return 0;
}

function runStep(label, args, cwd) {
  console.log(`\n[step] ${label}`);
  console.log(`$ node ${args.map(shellDisplay).join(" ")}`);
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`);
  }
}

function parseArgs(argv) {
  const out = {
    coordDir: "./coord",
    project: "",
    task: "",
    taskFile: "",
    draftPlan: "",
    requirements: "",
    constraints: "",
    chatContext: "",
    repoScanSummary: "",
    timeoutMs: 10 * 60 * 1000,
    skipPreflightAuth: false,
    approveDraft: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--coord":
        out.coordDir = requireValue(argv, ++i, arg);
        break;
      case "--project":
        out.project = requireValue(argv, ++i, arg);
        break;
      case "--task":
        out.task = requireValue(argv, ++i, arg);
        break;
      case "--task-file":
        out.taskFile = requireValue(argv, ++i, arg);
        break;
      case "--draft-plan":
      case "--from-draft-plan":
        out.draftPlan = requireValue(argv, ++i, arg);
        break;
      case "--requirements":
        out.requirements = requireValue(argv, ++i, arg);
        break;
      case "--constraints":
        out.constraints = requireValue(argv, ++i, arg);
        break;
      case "--chat-context":
        out.chatContext = requireValue(argv, ++i, arg);
        break;
      case "--repo-scan-summary":
        out.repoScanSummary = requireValue(argv, ++i, arg);
        break;
      case "--timeout-ms":
        out.timeoutMs = parsePositiveInteger(requireValue(argv, ++i, arg), arg);
        break;
      case "--skip-preflight-auth":
        out.skipPreflightAuth = true;
        break;
      case "--approve-draft":
        out.approveDraft = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return out;
}

function appendOptionalValue(args, flag, value) {
  if (typeof value === "string" && value.trim() !== "") {
    args.push(flag, value);
  }
}

function readOptionalJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {
    return null;
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function resolveFrom(cwd, maybeRelative) {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(cwd, maybeRelative);
}

function shellDisplay(value) {
  const str = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(str) ? str : JSON.stringify(str);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-run.js --project <description> --task <task> [--coord ./coord] [--force]",
    "  node scripts/prepare-run.js --project <description> --task-file <file> [--requirements <csv>] [--constraints <csv>] [--chat-context <text>]",
    "  node scripts/prepare-run.js --approve-draft --draft-plan ./coord/plan-reviews/draft-plan-v1.json [--coord ./coord] [--force]",
    "",
    "Default mode runs preflight, bootstraps coord/ when needed, drafts a validated plan, then stops for caller approval.",
    "Approval mode materializes context.json, DECISIONS.md, and CALLER_CONTEXT.md, validates context.json, and prints the launch command.",
  ].join("\n");
}

module.exports = {
  parseArgs,
  runPrepareRun,
};
