#!/usr/bin/env node
"use strict";

/**
 * Drafts the first topology-aware decomposition artifact.
 *
 * The planner is read-only: it receives the user task plus a compact repository
 * scan and must return JSON. This script writes only under coord/plan-reviews/.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfig } = require("./lib/config");
const { formatModelHeadsUp } = require("./lib/model-headsup");
const { spawnCliTemplateSync, validateCliTemplate } = require("./lib/cli-template");
const { extractJsonObject } = require("./review-plan");

const VALID_EXECUTION_MODES = new Set(["direct", "single_worker", "parallel", "phased"]);
const REQUIRED_ARRAY_FIELDS = [
  "user_requirements",
  "constraints",
  "shared_foundation_assumptions",
  "known_risks",
];

if (require.main === module) {
  try {
    const code = runDraftPlan(process.argv.slice(2), process.cwd());
    process.exitCode = code;
  } catch (err) {
    console.error(`draft-plan failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function runDraftPlan(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const taskText = readTaskText(args, cwd);
  if (!taskText) {
    throw new Error("User task is empty.");
  }
  const config = loadConfig(cwd);
  const plannerCli = config.planner_cli || config.orchestrator_cli || config.default_cli;
  const template = config.cli_templates[plannerCli];
  const templateValidation = validateCliTemplate(plannerCli, template);
  if (!templateValidation.ok) {
    throw new Error(`cli_templates.${plannerCli} is invalid for planner_cli: ${templateValidation.message}`);
  }

  const coordDir = resolveFrom(cwd, args.coordDir);
  const planReviewsDir = path.join(coordDir, "plan-reviews");
  const draftPlanPath = path.join(planReviewsDir, "draft-plan-v1.json");
  const promptPath = path.join(planReviewsDir, "draft-plan-v1.prompt.md");
  const rawPath = path.join(planReviewsDir, "draft-plan-v1.raw.md");

  if (fs.existsSync(draftPlanPath) && !args.force) {
    throw new Error(`${path.relative(cwd, draftPlanPath)} already exists. Pass --force to overwrite the draft artifacts.`);
  }

  fs.mkdirSync(planReviewsDir, { recursive: true });

  const project = args.project || readContextProject(coordDir) || path.basename(cwd);
  const repoScan = args.repoScanSummary
    ? readTextFile(resolveFrom(cwd, args.repoScanSummary), "repo scan summary")
    : JSON.stringify(buildRepoScanSummary(cwd, coordDir), null, 2);
  const prompt = renderPlannerPrompt({
    project,
    taskText,
    repoScan,
    coordDir: path.relative(cwd, coordDir) || ".",
  });
  fs.writeFileSync(promptPath, prompt, "utf-8");

  console.log(formatModelHeadsUp(config, { plannerCli, workerClis: [config.default_cli] }));
  console.log("");
  console.log(`Draft planner: invoking ${plannerCli} (${templateValidation.mode} template).`);
  console.log(`Prompt: ${path.relative(cwd, promptPath)}`);

  const { result, mode } = spawnCliTemplateSync(plannerCli, template, {
    promptFile: promptPath,
    promptText: prompt,
    cwd: planReviewsDir,
    encoding: "utf-8",
    timeout: args.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });

  const raw = [
    result.stdout || "",
    result.stderr ? `\n\n[stderr]\n${result.stderr}` : "",
  ].join("");
  fs.writeFileSync(rawPath, raw, "utf-8");

  if (result.error) {
    throw new Error(formatSpawnError(result.error, args.timeoutMs));
  }
  if (result.status !== 0) {
    throw new Error(`Planner CLI exited with code ${result.status}. Raw output: ${path.relative(cwd, rawPath)}`);
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) {
    throw new Error(`Planner did not emit a parseable JSON object. Raw output: ${path.relative(cwd, rawPath)}`);
  }

  const validation = validateDraftPlan(parsed);
  if (!validation.ok) {
    const details = validation.errors.map((error) => `  - ${error}`).join("\n");
    throw new Error(`Planner JSON failed draft-plan validation:\n${details}\nRaw output: ${path.relative(cwd, rawPath)}`);
  }

  writeJsonFile(draftPlanPath, parsed);
  console.log(`Planner output captured (${mode}); raw stream: ${path.relative(cwd, rawPath)}`);
  console.log(`Canonical draft plan: ${path.relative(cwd, draftPlanPath)}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Review and edit ${path.relative(cwd, draftPlanPath)} if needed.`);
  console.log(`  2. Optional review: node ${path.join(__dirname, "review-plan.js")} --iteration 1 --draft-plan ${path.relative(cwd, draftPlanPath)} --coord ${path.relative(cwd, coordDir) || "."}`);
  console.log("  3. Materialize context.json, DECISIONS.md, and CALLER_CONTEXT.md after caller approval.");
  return 0;
}

function renderPlannerPrompt({ project, taskText, repoScan, coordDir }) {
  const responseShape = {
    project,
    user_requirements: ["string"],
    constraints: ["string"],
    candidate_execution_topology: {
      execution_mode: "direct | single_worker | parallel | phased",
      reason: "string",
      rejected_alternatives: [
        { execution_mode: "direct | single_worker | parallel | phased", reason: "string" },
      ],
      dependency_notes: ["string"],
      shared_foundation_notes: ["string"],
      mode_specific_decomposition: ["string"],
    },
    shared_foundation_assumptions: ["string"],
    known_risks: ["string"],
    tasks: {
      "agent-name": {
        description: "string",
        allowed_paths: ["string"],
        forbidden_paths: ["string"],
        read_first: ["string"],
        validation_command: ["string"],
        sequencing_notes: ["string"],
      },
    },
  };

  return [
    "You are a read-only initial decomposition planner for a multi-agent coding orchestrator.",
    "",
    "Rules:",
    "- Return exactly one JSON object and no prose outside it.",
    "- Do not edit files, create worktrees, create branches, launch workers, run commands, or start the background loop.",
    "- The caller agent will review and may change your draft before anything is launched.",
    "- Choose one execution topology: direct, single_worker, parallel, or phased.",
    "- Use direct for small or tightly coupled work that should stay in the caller session.",
    "- Use single_worker for substantial sequential work with exactly one worker task.",
    "- Use parallel only when worker file ownership is genuinely non-overlapping.",
    "- Use phased when shared foundations must be committed first, then independent leaves can fan out.",
    "- Put shared files such as package.json, config files, schemas, routers, shared types, and lockfiles in shared foundation notes unless one worker can safely own them.",
    "- For each worker task, include precise allowed_paths, forbidden_paths, read_first, sequencing_notes, and a validation_command.",
    "- Prefer validation_command as a JSON argv array; use null only when no automated validation is possible.",
    "- Do not include long file contents or chat transcripts.",
    "",
    "Required JSON response shape:",
    "```json",
    JSON.stringify(responseShape, null, 2),
    "```",
    "",
    "## Project",
    project,
    "",
    "## Coordination Directory",
    coordDir,
    "",
    "## User Task",
    taskText,
    "",
    "## Repository Scan Summary",
    "```json",
    repoScan,
    "```",
    "",
  ].join("\n");
}

function validateDraftPlan(plan) {
  const errors = [];
  if (!isPlainObject(plan)) {
    return { ok: false, errors: ["Draft plan must be a JSON object."] };
  }
  if (typeof plan.project !== "string" || plan.project.trim() === "") {
    errors.push("project must be a non-empty string.");
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    validateStringArray(plan[field], field, { required: true }, errors);
  }

  const topology = plan.candidate_execution_topology;
  if (!isPlainObject(topology)) {
    errors.push("candidate_execution_topology must be an object.");
  } else {
    if (!VALID_EXECUTION_MODES.has(topology.execution_mode)) {
      errors.push("candidate_execution_topology.execution_mode must be direct, single_worker, parallel, or phased.");
    }
    if (typeof topology.reason !== "string" || topology.reason.trim() === "") {
      errors.push("candidate_execution_topology.reason must be a non-empty string.");
    }
    validateRejectedAlternatives(topology.rejected_alternatives, errors);
    validateStringArray(topology.dependency_notes, "candidate_execution_topology.dependency_notes", { required: true }, errors);
    validateStringArray(topology.shared_foundation_notes, "candidate_execution_topology.shared_foundation_notes", { required: true }, errors);
    validateStringArray(topology.mode_specific_decomposition, "candidate_execution_topology.mode_specific_decomposition", { required: true }, errors);
  }

  const tasks = plan.tasks;
  if (!isPlainObject(tasks)) {
    errors.push("tasks must be an object keyed by agent name.");
  } else if (topology && topology.execution_mode) {
    const taskNames = Object.keys(tasks);
    if (topology.execution_mode === "direct" && taskNames.length > 0) {
      errors.push("direct topology must not include worker tasks.");
    }
    if (topology.execution_mode === "single_worker" && taskNames.length !== 1) {
      errors.push("single_worker topology must include exactly one task.");
    }
    if ((topology.execution_mode === "parallel" || topology.execution_mode === "phased") && taskNames.length < 2) {
      errors.push(`${topology.execution_mode} topology must include at least two worker tasks.`);
    }
    for (const taskName of taskNames) {
      validateDraftTask(taskName, tasks[taskName], errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateRejectedAlternatives(value, errors) {
  if (!Array.isArray(value)) {
    errors.push("candidate_execution_topology.rejected_alternatives must be an array.");
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) {
      errors.push(`candidate_execution_topology.rejected_alternatives[${i}] must be an object.`);
      continue;
    }
    if (!VALID_EXECUTION_MODES.has(item.execution_mode)) {
      errors.push(`candidate_execution_topology.rejected_alternatives[${i}].execution_mode is invalid.`);
    }
    if (typeof item.reason !== "string" || item.reason.trim() === "") {
      errors.push(`candidate_execution_topology.rejected_alternatives[${i}].reason must be a non-empty string.`);
    }
  }
}

function validateDraftTask(taskName, task, errors) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskName)) {
    errors.push(`tasks.${taskName} has an unsafe name for branch/worktree creation.`);
  }
  if (!isPlainObject(task)) {
    errors.push(`tasks.${taskName} must be an object.`);
    return;
  }
  if (typeof task.description !== "string" || task.description.trim() === "") {
    errors.push(`tasks.${taskName}.description must be a non-empty string.`);
  }
  validateStringArray(task.allowed_paths, `tasks.${taskName}.allowed_paths`, { required: true, minLength: 1 }, errors);
  validateStringArray(task.forbidden_paths, `tasks.${taskName}.forbidden_paths`, { required: true }, errors);
  validateStringArray(task.read_first, `tasks.${taskName}.read_first`, { required: true }, errors);
  validateStringArray(task.sequencing_notes, `tasks.${taskName}.sequencing_notes`, { required: true }, errors);
  validateValidationCommand(task.validation_command, `tasks.${taskName}.validation_command`, errors);
}

function validateStringArray(value, label, options, errors) {
  if (value === undefined) {
    if (options.required) errors.push(`${label} must be an array of strings.`);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings.`);
    return;
  }
  if (options.minLength && value.length < options.minLength) {
    errors.push(`${label} must contain at least ${options.minLength} item.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${label}[${index}] must be a non-empty string.`);
    }
  });
}

function validateValidationCommand(value, label, errors) {
  if (value === null) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      errors.push(`${label} must not be an empty array; use null if no automated validation is possible.`);
    }
    value.forEach((item, index) => {
      if (typeof item !== "string" || item.trim() === "") {
        errors.push(`${label}[${index}] must be a non-empty string.`);
      }
    });
    return;
  }
  if (typeof value === "string" && value.trim() !== "") return;
  errors.push(`${label} must be a JSON argv array, shell command string, or null.`);
}

function buildRepoScanSummary(projectRoot, coordDir) {
  const packageJson = readPackageJson(projectRoot);
  return {
    project_root: projectRoot,
    git_branch: runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git_status_short: runGit(projectRoot, ["status", "--short"]).split("\n").filter(Boolean).slice(0, 80),
    top_level_entries: listTopLevelEntries(projectRoot),
    package_manager: inferPackageManager(projectRoot),
    package_scripts: packageJson && packageJson.scripts ? packageJson.scripts : {},
    package_dependencies: packageJson ? Object.keys(packageJson.dependencies || {}).slice(0, 80) : [],
    package_dev_dependencies: packageJson ? Object.keys(packageJson.devDependencies || {}).slice(0, 80) : [],
    candidate_validation_commands: inferValidationCommands(projectRoot, packageJson),
    repo_files_sample: collectRepoFiles(projectRoot, coordDir, 240),
  };
}

function readPackageJson(projectRoot) {
  const file = path.join(projectRoot, "package.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {
    return null;
  }
}

function inferPackageManager(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(projectRoot, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(projectRoot, "bun.lock")) || fs.existsSync(path.join(projectRoot, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(projectRoot, "package-lock.json"))) return "npm";
  if (fs.existsSync(path.join(projectRoot, "package.json"))) return "npm";
  return null;
}

function inferValidationCommands(projectRoot, packageJson) {
  const out = [];
  const packageManager = inferPackageManager(projectRoot);
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};
  for (const script of ["test", "lint", "typecheck", "check"]) {
    if (scripts[script]) out.push([packageManager || "npm", "run", script]);
  }
  if (fs.existsSync(path.join(projectRoot, "scripts", "run-tests.js"))) {
    out.push(["node", "scripts/run-tests.js"]);
  }
  if (fs.existsSync(path.join(projectRoot, "tests"))) {
    out.push(["node", "--test"]);
  }
  return out.slice(0, 8);
}

function listTopLevelEntries(projectRoot) {
  try {
    return fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => !shouldSkipEntry(entry.name))
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .slice(0, 80);
  } catch (_) {
    return [];
  }
}

function collectRepoFiles(projectRoot, coordDir, limit) {
  const out = [];
  const coordAbs = path.resolve(coordDir);
  walk(projectRoot);
  return out;

  function walk(dir) {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (shouldSkipEntry(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (abs === coordAbs || abs.startsWith(`${coordAbs}${path.sep}`)) continue;
      const rel = toPosix(path.relative(projectRoot, abs));
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
}

function shouldSkipEntry(name) {
  return new Set([
    ".git",
    ".agents",
    ".kilocode",
    "coord",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".cache",
  ]).has(name);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

function parseArgs(argv) {
  const out = {
    coordDir: "./coord",
    project: "",
    task: "",
    taskFile: "",
    repoScanSummary: "",
    timeoutMs: 10 * 60 * 1000,
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
      case "--repo-scan-summary":
        out.repoScanSummary = requireValue(argv, ++i, arg);
        break;
      case "--timeout-ms":
        out.timeoutMs = parsePositiveInteger(requireValue(argv, ++i, arg), arg);
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
  if (out.help) return out;
  if (!out.task && !out.taskFile) {
    throw new Error(`--task or --task-file is required.\n\n${usage()}`);
  }
  if (out.task && out.taskFile) {
    throw new Error("Use either --task or --task-file, not both.");
  }
  return out;
}

function readTaskText(args, cwd) {
  if (args.taskFile) {
    return readTextFile(resolveFrom(cwd, args.taskFile), "task file").trim();
  }
  return args.task.trim();
}

function readContextProject(coordDir) {
  const contextPath = path.join(coordDir, "context.json");
  if (!fs.existsSync(contextPath)) return "";
  try {
    const context = JSON.parse(fs.readFileSync(contextPath, "utf-8"));
    return typeof context.project === "string" ? context.project.trim() : "";
  } catch (_) {
    return "";
  }
}

function readTextFile(file, label) {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Unable to read ${label} at ${file}: ${err.message}`);
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
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

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

function formatSpawnError(error, timeoutMs) {
  if (error.code === "ETIMEDOUT") return `Planner CLI timed out after ${timeoutMs}ms.`;
  return error.message;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/draft-plan.js --task <task> [--project <name>] [--coord ./coord] [--force]",
    "  node scripts/draft-plan.js --task-file <file> [--repo-scan-summary <file>] [--timeout-ms 600000]",
    "",
    "Writes coord/plan-reviews/draft-plan-v1.json from a read-only planner CLI call.",
  ].join("\n");
}

module.exports = {
  buildRepoScanSummary,
  parseArgs,
  renderPlannerPrompt,
  runDraftPlan,
  validateDraftPlan,
};
