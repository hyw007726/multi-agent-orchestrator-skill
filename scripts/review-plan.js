#!/usr/bin/env node
"use strict";

/**
 * Runs one read-only plan-review iteration.
 *
 * Usage:
 *   node scripts/review-plan.js --iteration 1 --draft-plan coord/plan-reviews/draft-plan-v1.json
 *   node scripts/review-plan.js --iteration 2 --draft-plan coord/plan-reviews/draft-plan-v2.json --previous-reconciliation coord/plan-reviews/iteration-1/reconciliation.json
 *
 * This script intentionally executes one iteration at a time. In "auto" mode,
 * the main caller reconciles feedback and explicitly chooses whether to invoke
 * this command again for the next iteration.
 */

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { spawnCliTemplate, validateCliTemplate } = require("./lib/cli-template");
const { extractJsonObject } = require("./lib/provider-output");

const REQUIRED_ARRAY_FIELDS = [
  "execution_mode_issues",
  "blockers",
  "overlaps",
  "missing_foundation_work",
  "sequencing_risks",
  "validation_gaps",
  "suggested_changes",
];

if (require.main === module) {
  runReviewPlan(process.argv.slice(2), process.cwd())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`review-plan failed: ${err.message}`);
      process.exitCode = 1;
    });
}

async function runReviewPlan(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const config = loadConfig(cwd);
  const reviewers = Array.isArray(config.reviewers) ? config.reviewers : [];
  if (reviewers.length === 0) {
    console.log("No plan reviewers configured. Skipping Phase 1.5 plan review.");
    return 0;
  }

  const coordDir = resolveFrom(cwd, args.coord);
  const planReviewsDir = path.join(coordDir, "plan-reviews");
  const iterationDir = path.join(planReviewsDir, `iteration-${args.iteration}`);
  fs.mkdirSync(iterationDir, { recursive: true });

  const draftPlanPath = resolveFrom(cwd, args.draftPlan);
  const draftPlan = readJsonFile(draftPlanPath, "draft plan");
  const draftPlanAuditPath = path.join(planReviewsDir, `draft-plan-v${args.iteration}.json`);
  writeJsonFile(draftPlanAuditPath, draftPlan);

  let previousReconciliation = null;
  let previousReconciliationPath = null;
  if (args.previousReconciliation) {
    previousReconciliationPath = resolveFrom(cwd, args.previousReconciliation);
    previousReconciliation = readTextOrJson(previousReconciliationPath);
  } else if (args.iteration > 1) {
    throw new Error("--previous-reconciliation is required for review iterations after iteration 1.");
  }

  const defaultTimeoutMs = args.timeoutMs || Math.max(1, config.default_timeout_mins || 10) * 60 * 1000;
  console.log(`Plan review iteration ${args.iteration}: running ${reviewers.length} reviewer(s).`);
  console.log(`Draft plan audit: ${path.relative(cwd, draftPlanAuditPath)}`);
  console.log(`Artifacts: ${path.relative(cwd, iterationDir)}`);
  console.log(`Configured max_plan_review_iterations: ${config.max_plan_review_iterations}`);

  const results = await Promise.all(reviewers.map((reviewer) => runReviewer({
    reviewer,
    config,
    cwd,
    iteration: args.iteration,
    iterationDir,
    draftPlan,
    draftPlanPath,
    draftPlanAuditPath,
    previousReconciliation,
    previousReconciliationPath,
    defaultTimeoutMs,
  })));

  const succeeded = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log(`Plan review iteration ${args.iteration} complete: ${succeeded.length} succeeded, ${failed.length} failed.`);
  for (const result of results) {
    const marker = result.ok ? "OK" : "FAILED";
    const detail = result.ok ? path.relative(cwd, result.jsonPath) : result.error;
    console.log(`  ${marker} ${result.reviewer}: ${detail}`);
  }

  if (succeeded.length === 0) {
    console.error("All configured plan reviewers failed. Resolve reviewer CLI/output issues before relying on review feedback.");
    return 1;
  }

  if (failed.length > 0) {
    console.error("Some plan reviewers failed; valid reviewer JSON was still captured for the successful reviewers.");
  }
  return 0;
}

function runReviewer(options) {
  const {
    reviewer,
    config,
    iteration,
    iterationDir,
    draftPlan,
    draftPlanPath,
    draftPlanAuditPath,
    previousReconciliation,
    previousReconciliationPath,
    defaultTimeoutMs,
  } = options;

  const markdownPath = path.join(iterationDir, `${reviewer.name}.md`);
  const jsonPath = path.join(iterationDir, `${reviewer.name}.json`);
  const promptPath = path.join(iterationDir, `${reviewer.name}.prompt.md`);
  const prompt = renderReviewerPrompt({
    reviewer,
    config,
    iteration,
    draftPlan,
    draftPlanPath,
    draftPlanAuditPath,
    previousReconciliation,
    previousReconciliationPath,
  });

  fs.writeFileSync(promptPath, prompt, "utf-8");
  fs.writeFileSync(markdownPath, [
    `# Plan Review Iteration ${iteration}: ${reviewer.name}`,
    "",
    `- CLI: ${reviewer.cli}`,
    `- Review focus: ${reviewer.review_focus}`,
    `- Prompt file: ${promptPath}`,
    "",
    "## Stream",
    "",
  ].join("\n"), "utf-8");

  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let killTimer = null;
    const timeoutMs = reviewer.timeout_mins
      ? Math.max(1, reviewer.timeout_mins * 60 * 1000)
      : defaultTimeoutMs;

    try {
      const template = config.cli_templates[reviewer.cli];
      const validation = validateCliTemplate(reviewer.cli, template);
      if (!validation.ok) {
        throw new Error(validation.message);
      }

      child = spawnCliTemplate(reviewer.cli, template, {
        promptFile: promptPath,
        promptText: prompt,
        cwd: iterationDir,
        stdio: ["ignore", "pipe", "pipe"],
        extraArgs: reviewerExtraArgs(reviewer),
      });
    } catch (err) {
      appendMarkdown(markdownPath, `\n## Failure\n\n${err.message}\n`);
      resolve({
        ok: false,
        reviewer: reviewer.name,
        markdownPath,
        jsonPath,
        error: err.message,
      });
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      appendMarkdown(markdownPath, `\n\n[timeout] exceeded ${timeoutMs}ms; terminating reviewer process.\n`);
      try { child.kill("SIGTERM"); } catch (_) {}
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) {}
      }, 2000);
      if (killTimer.unref) killTimer.unref();
    }, timeoutMs);
    if (timeout.unref) timeout.unref();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      appendMarkdown(markdownPath, `\n\n[stdout]\n\n${text}`);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      appendMarkdown(markdownPath, `\n\n[stderr]\n\n${text}`);
    });
    child.on("error", (err) => {
      spawnError = err;
      appendMarkdown(markdownPath, `\n\n[spawn-error]\n\n${err.message}\n`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);

      const output = stdout.trim() ? stdout : `${stdout}\n${stderr}`;
      const parsed = extractJsonObject(output);
      const validation = parsed
        ? validateReviewerResponse(parsed, reviewer.name, iteration)
        : { ok: false, message: "Reviewer did not emit a parseable JSON object." };

      let ok = true;
      let error = null;
      if (timedOut) {
        ok = false;
        error = `Timed out after ${timeoutMs}ms.`;
      } else if (spawnError) {
        ok = false;
        error = spawnError.message;
      } else if (code !== 0) {
        ok = false;
        error = `Exited with code ${code}${signal ? ` (signal ${signal})` : ""}.`;
      } else if (!validation.ok) {
        ok = false;
        error = validation.message;
      }

      const hasValidResponse = parsed && validation.ok;
      if (hasValidResponse) {
        writeJsonFile(jsonPath, parsed);
        appendMarkdown(markdownPath, `\n\n## Parsed JSON\n\nStored at ${jsonPath}\n`);
      }

      if (!ok) {
        appendMarkdown(markdownPath, `\n\n## Failure\n\n${error}\n`);
      }

      resolve({
        ok,
        reviewer: reviewer.name,
        markdownPath,
        jsonPath,
        error,
      });
    });
  });
}

function renderReviewerPrompt(options) {
  const {
    reviewer,
    config,
    iteration,
    draftPlan,
    draftPlanPath,
    draftPlanAuditPath,
    previousReconciliation,
    previousReconciliationPath,
  } = options;

  const responseShape = {
    iteration,
    reviewer: reviewer.name,
    summary: "string",
    execution_mode_issues: ["string"],
    blockers: ["string"],
    overlaps: ["string"],
    missing_foundation_work: ["string"],
    sequencing_risks: ["string"],
    validation_gaps: ["string"],
    suggested_changes: ["string"],
  };

  return [
    "You are a read-only plan reviewer for a multi-agent decomposition plan.",
    "",
    "Rules:",
    "- Critique only the decomposition plan. Do not edit files, create git worktrees, launch workers, or start the background loop.",
    "- Do not communicate with other reviewers. The main caller owns synthesis and final decisions.",
    "- Review the latest draft plan and prior reconciliation notes below. Do not assume an earlier draft is current.",
    "- Focus on execution topology, decomposition quality, ownership boundaries, shared-foundation work, sequencing, and validation.",
    "- Critique whether the selected execution mode is too heavy, too weak, or incorrectly sequenced.",
    "- Ask whether `parallel` should really be `phased`, whether `single_worker` or `direct` would avoid unnecessary coordination, and whether worker boundaries are safe for the chosen mode.",
    "- Check the draft `foundation` block: missing foundation work should be called out, completed_committed foundations need committed paths and a commit, and owned_by_worker foundations need exactly one owner with non-overlapping worker boundaries.",
    "- Return exactly one JSON object and no prose outside it. Use empty arrays when no issues exist.",
    "",
    "Required JSON fields:",
    "- `iteration`: the exact review iteration number from `Dynamic Review Constants`.",
    "- `reviewer`: the exact reviewer name from `Dynamic Review Constants`.",
    "- `summary`: string.",
    "- `execution_mode_issues`, `blockers`, `overlaps`, `missing_foundation_work`, `sequencing_risks`, `validation_gaps`, and `suggested_changes`: arrays of strings.",
    "",
    "Review inputs the draft plan should cover: user requirements, constraints, candidate execution topology, rejected topology alternatives, topology reason, dependency notes, candidate file ownership, shared-foundation assumptions, machine-readable foundation state, mode-specific task decomposition, validation commands, and known risks.",
    "",
    "## Dynamic Review Constants",
    `Reviewer name: ${reviewer.name}`,
    `Review focus: ${reviewer.review_focus}`,
    `Review iteration: ${iteration}`,
    `Configured max_plan_review_iterations: ${config.max_plan_review_iterations}`,
    "",
    "Required JSON response shape:",
    "```json",
    JSON.stringify(responseShape, null, 2),
    "```",
    "",
    `Latest draft plan source path: ${draftPlanPath}`,
    `Latest draft plan audit path: ${draftPlanAuditPath}`,
    "",
    "Latest draft plan JSON:",
    "```json",
    JSON.stringify(draftPlan, null, 2),
    "```",
    "",
    `Previous reconciliation path: ${previousReconciliationPath || "(none for iteration 1)"}`,
    "",
    "Previous reconciliation notes:",
    "```json",
    previousReconciliation === null ? "null" : JSON.stringify(previousReconciliation, null, 2),
    "```",
    "",
  ].join("\n");
}

function reviewerExtraArgs(reviewer) {
  const args = [];
  if (reviewer.model) {
    args.push(reviewer.model_flag || "--model", reviewer.model);
  }
  if (Array.isArray(reviewer.template_args)) {
    args.push(...reviewer.template_args);
  }
  return args;
}

function validateReviewerResponse(value, reviewerName, iteration) {
  if (!isPlainObject(value)) {
    return { ok: false, message: "Reviewer JSON must be an object." };
  }
  if (value.iteration !== iteration) {
    return { ok: false, message: `Reviewer JSON field iteration must equal ${iteration}.` };
  }
  if (value.reviewer !== reviewerName) {
    return { ok: false, message: `Reviewer JSON field reviewer must equal '${reviewerName}'.` };
  }
  if (typeof value.summary !== "string") {
    return { ok: false, message: "Reviewer JSON field summary must be a string." };
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) {
      return { ok: false, message: `Reviewer JSON field ${field} must be an array.` };
    }
  }
  return { ok: true };
}

function parseArgs(argv) {
  const out = {
    coord: "./coord",
    draftPlan: null,
    iteration: null,
    previousReconciliation: null,
    timeoutMs: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--coord":
        out.coord = requireValue(argv, ++i, arg);
        break;
      case "--draft-plan":
        out.draftPlan = requireValue(argv, ++i, arg);
        break;
      case "--iteration":
        out.iteration = parsePositiveInteger(requireValue(argv, ++i, arg), arg);
        break;
      case "--previous-reconciliation":
      case "--reconciliation":
        out.previousReconciliation = requireValue(argv, ++i, arg);
        break;
      case "--timeout-ms":
        out.timeoutMs = parsePositiveInteger(requireValue(argv, ++i, arg), arg);
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
  if (!out.draftPlan) throw new Error(`--draft-plan is required.\n\n${usage()}`);
  if (!out.iteration) throw new Error(`--iteration is required.\n\n${usage()}`);
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/review-plan.js --iteration <N> --draft-plan <path> [--previous-reconciliation <path>] [--coord ./coord] [--timeout-ms 600000]",
    "",
    "Runs exactly one configured plan-review iteration and writes artifacts under coord/plan-reviews/.",
  ].join("\n");
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

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`Unable to read ${label} JSON at ${file}: ${err.message}`);
  }
}

function readTextOrJson(file) {
  const text = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function appendMarkdown(file, text) {
  fs.appendFileSync(file, text, "utf-8");
}

function resolveFrom(cwd, maybeRelative) {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(cwd, maybeRelative);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  extractJsonObject,
  parseArgs,
  renderReviewerPrompt,
  reviewerExtraArgs,
  runReviewPlan,
  validateReviewerResponse,
};
