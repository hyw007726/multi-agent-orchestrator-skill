#!/usr/bin/env node
"use strict";

/**
 * Converts a reviewed draft-plan artifact into launch-ready coordination files.
 *
 * This is intentionally separate from bootstrap and launch: callers can still
 * edit coord/context.json and coord/DECISIONS.md manually instead of using it.
 */

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { validateContext, formatValidationReport } = require("./lib/context-validation");
const { validateDraftPlan } = require("./draft-plan");

if (require.main === module) {
  try {
    const code = runMaterializePlan(process.argv.slice(2), process.cwd());
    process.exitCode = code;
  } catch (err) {
    console.error(`materialize-plan failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function runMaterializePlan(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const coordDir = resolveFrom(cwd, args.coordDir);
  const draftPlanPath = resolveFrom(cwd, args.draftPlan);
  const contextPath = path.join(coordDir, "context.json");
  const decisionsPath = path.join(coordDir, "DECISIONS.md");
  const callerContextPath = path.join(coordDir, "CALLER_CONTEXT.md");

  const draftPlan = readJsonFile(draftPlanPath, "draft plan");
  const draftValidation = validateDraftPlan(draftPlan);
  if (!draftValidation.ok) {
    throw new Error(`Draft plan is not valid:\n${formatList(draftValidation.errors)}`);
  }

  const existingContext = readOptionalJson(contextPath) || {};
  const existingTasks = existingContext.tasks && typeof existingContext.tasks === "object"
    ? Object.keys(existingContext.tasks)
    : [];
  if (existingTasks.length > 0 && !args.force) {
    throw new Error(`${path.relative(cwd, contextPath)} already contains ${existingTasks.length} task(s). Pass --force to overwrite generated coordination files, or edit context.json manually.`);
  }

  const generatedAt = new Date().toISOString();
  const sourceDraft = path.relative(cwd, draftPlanPath) || draftPlanPath;
  const context = buildContextFromDraftPlan(draftPlan, {
    existingContext,
    generatedAt,
  });
  const decisions = buildDecisionsMarkdown(draftPlan, {
    generatedAt,
    sourceDraft,
  });
  const callerContext = buildCallerContextMarkdown(draftPlan, {
    existingContext,
    generatedAt,
    sourceDraft,
    coordDir: path.relative(cwd, coordDir) || ".",
    projectRoot: cwd,
  });

  const config = loadConfig(cwd);
  const launchable = context.execution_topology.execution_mode !== "direct";
  const validation = validateContext(context, config, {
    projectRoot: cwd,
    coordDir: args.coordDir,
    requireLaunchable: launchable,
  });
  if (!validation.ok) {
    throw new Error(`Generated context.json failed validation:\n${formatList(validation.errors)}`);
  }

  fs.mkdirSync(coordDir, { recursive: true });
  writeJsonFile(contextPath, context);
  fs.writeFileSync(decisionsPath, decisions, "utf-8");
  fs.writeFileSync(callerContextPath, callerContext, "utf-8");

  const validationText = formatValidationReport(validation, {
    coordDir: args.coordDir,
    contextPath: path.relative(cwd, contextPath),
    decisionsPath: path.relative(cwd, decisionsPath),
    validateCommand: `node ${path.join(__dirname, "validate-context.js")} --coord ${args.coordDir}`,
  });
  if (validationText) {
    process.stdout.write(`${validationText}\n\n`);
  }

  console.log(`Materialized context: ${path.relative(cwd, contextPath)}`);
  console.log(`Materialized decisions: ${path.relative(cwd, decisionsPath)}`);
  console.log(`Materialized caller context: ${path.relative(cwd, callerContextPath)}`);
  if (context.execution_topology.execution_mode === "direct") {
    console.log("Execution topology is direct; do not run launch-all.js for this plan.");
  } else {
    console.log(`Next validation: node ${path.join(__dirname, "validate-context.js")} --coord ${args.coordDir}`);
    console.log(`Next launch: node ${path.join(__dirname, "launch-all.js")} --coord ${args.coordDir}`);
  }
  return 0;
}

function buildContextFromDraftPlan(draftPlan, options = {}) {
  const existingContext = options.existingContext || {};
  const topology = draftPlan.candidate_execution_topology || {};
  const generatedAt = options.generatedAt || new Date().toISOString();
  const executionMode = topology.execution_mode;

  return {
    project: draftPlan.project,
    chat_context: normalizeChatContext(existingContext.chat_context),
    execution_topology: {
      execution_mode: executionMode,
      reason: topology.reason || "",
      dependency_notes: compactList([
        ...(topology.dependency_notes || []),
        ...(topology.shared_foundation_notes || []).map((note) => `Shared foundation: ${note}`),
      ]),
    },
    requirements: compactList(draftPlan.user_requirements || []),
    constraints: compactList(draftPlan.constraints || []),
    created_at: existingContext.created_at || generatedAt,
    tasks: executionMode === "direct" ? {} : buildContextTasks(draftPlan.tasks || {}),
  };
}

function buildContextTasks(tasks) {
  const out = {};
  for (const [agentName, task] of Object.entries(tasks)) {
    out[agentName] = stripUndefined({
      description: task.description,
      read_first: compactList(task.read_first || []),
      allowed_paths: compactList(task.allowed_paths || []),
      forbidden_paths: compactList(task.forbidden_paths || []),
      validation_command: task.validation_command === undefined ? null : task.validation_command,
      cli: optionalString(task.cli),
      mode: optionalString(task.mode),
      timeout_mins: optionalNumber(task.timeout_mins),
      progress_timeout_mins: optionalNumber(task.progress_timeout_mins),
    });
  }
  return out;
}

function buildDecisionsMarkdown(draftPlan, options = {}) {
  const topology = draftPlan.candidate_execution_topology || {};
  const sourceDraft = options.sourceDraft || "(unknown)";
  const generatedAt = options.generatedAt || new Date().toISOString();
  const mode = topology.execution_mode || "(unknown)";
  const lines = [
    "# Architectural Decisions",
    "",
    "This file is the curated human-readable contract for durable requirements, shared API contracts, data models, file ownership, and structural decisions. Worker agents MUST read this file before they begin coding.",
    "",
    "## Project",
    formatBullets([draftPlan.project || "Fill this in during decomposition."]),
    "",
    "## Final Execution Topology",
    `- Mode: ${mode}`,
    `- Rationale: ${topology.reason || "(none recorded)"}`,
    "",
    "### Rejected Alternatives",
    formatRejectedAlternatives(topology.rejected_alternatives || []),
    "",
    "### Dependency Notes",
    formatBullets(topology.dependency_notes || [], "No dependency notes recorded."),
    "",
    "### Shared Foundation",
    formatBullets([
      ...(topology.shared_foundation_notes || []),
      ...(draftPlan.shared_foundation_assumptions || []).map((item) => `Assumption: ${item}`),
    ], "No shared-foundation assumptions recorded."),
    "",
    "## Durable Requirements",
    formatBullets(draftPlan.user_requirements || [], "No durable requirements recorded."),
    "",
    "## Constraints",
    formatBullets(draftPlan.constraints || [], "No constraints recorded."),
    "",
    "## Shared Contracts",
    "- Add API shapes, data models, invariants, and cross-agent integration points here before launch if the draft plan did not already make them explicit.",
    "",
    "## File Ownership",
    formatTaskOwnership(draftPlan.tasks || {}, mode),
    "",
    "## Known Risks",
    formatBullets(draftPlan.known_risks || [], "No known risks recorded."),
    "",
    "## Materialization",
    `- Source draft plan: ${sourceDraft}`,
    `- Generated at: ${generatedAt}`,
    "",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function buildCallerContextMarkdown(draftPlan, options = {}) {
  const topology = draftPlan.candidate_execution_topology || {};
  const existingContext = options.existingContext || {};
  const chatContext = normalizeChatContext(existingContext.chat_context);
  const sourceDraft = options.sourceDraft || "(unknown)";
  const generatedAt = options.generatedAt || new Date().toISOString();
  const coordDir = options.coordDir || "./coord";
  const projectRoot = options.projectRoot || process.cwd();
  const lines = [
    "# Caller Context",
    "",
    "This file preserves compressed caller-session context for the headless orchestration loop. It captures user intent, important chat nuance, environment assumptions, and non-durable rationale that should not bloat coord/context.json. Durable requirements, shared contracts, and ownership rules belong in coord/DECISIONS.md.",
    "",
    "## User Intent",
    formatBullets([
      draftPlan.project,
      ...(draftPlan.user_requirements || []),
    ], "No user intent recorded."),
    "",
    "## Important Chat Nuance",
    formatChatContext(chatContext),
    "",
    "## Environment Assumptions",
    formatBullets([
      `Project root at materialization: ${projectRoot}`,
      `Coord directory: ${coordDir}`,
      "Workers and the background loop do not have the original chat transcript; rely on this file plus DECISIONS.md and context.json.",
    ]),
    "",
    "## Non-Durable Rationale",
    formatBullets([
      `Selected topology during draft planning: ${topology.execution_mode || "(unknown)"}`,
      topology.reason ? `Topology rationale: ${topology.reason}` : "",
      ...(topology.mode_specific_decomposition || []).map((item) => `Decomposition note: ${item}`),
      ...(draftPlan.known_risks || []).map((item) => `Known risk: ${item}`),
    ], "No non-durable rationale recorded."),
    "",
    "## Source",
    `- Source draft plan: ${sourceDraft}`,
    `- Generated at: ${generatedAt}`,
    "",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function formatChatContext(chatContext) {
  const lines = [];
  for (const [key, value] of Object.entries(chatContext || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          lines.push(`- ${key}: ${item.trim()}`);
        }
      }
    } else if (typeof value === "string" && value.trim()) {
      lines.push(`- ${key}: ${value.trim()}`);
    }
  }
  return lines.length === 0
    ? "- No additional chat nuance was preserved in the existing context."
    : lines.join("\n");
}

function formatRejectedAlternatives(items) {
  if (!Array.isArray(items) || items.length === 0) return "- No rejected alternatives recorded.";
  return items
    .map((item) => `- ${item.execution_mode || "(unknown)"}: ${item.reason || "(no reason recorded)"}`)
    .join("\n");
}

function formatTaskOwnership(tasks, executionMode) {
  const entries = Object.entries(tasks || {});
  if (executionMode === "direct") {
    return "- Direct mode: no worker file ownership. Handle this task in the caller session.";
  }
  if (entries.length === 0) return "- No worker tasks recorded.";

  return entries.map(([agentName, task]) => [
    `### ${agentName}`,
    `- Task: ${task.description || "(none recorded)"}`,
    `- Allowed paths: ${formatInlineList(task.allowed_paths)}`,
    `- Forbidden paths: ${formatInlineList(task.forbidden_paths)}`,
    `- Read first: ${formatInlineList(task.read_first)}`,
    `- Validation command: ${formatValidationCommand(task.validation_command)}`,
    "- Sequencing notes:",
    indentBullets(task.sequencing_notes || [], "No sequencing notes recorded."),
  ].join("\n")).join("\n\n");
}

function formatValidationCommand(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `\`${JSON.stringify(value)}\``;
  return `\`${String(value)}\``;
}

function formatInlineList(value) {
  const items = compactList(value || []);
  return items.length === 0 ? "(none)" : items.join(", ");
}

function formatBullets(items, fallback) {
  const compact = compactList(items || []);
  if (compact.length === 0) return `- ${fallback}`;
  return compact.map((item) => `- ${item}`).join("\n");
}

function indentBullets(items, fallback) {
  const compact = compactList(items || []);
  if (compact.length === 0) return `  - ${fallback}`;
  return compact.map((item) => `  - ${item}`).join("\n");
}

function compactList(items) {
  return Array.from(new Set((items || [])
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)));
}

function normalizeChatContext(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function stripUndefined(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function parseArgs(argv) {
  const out = {
    coordDir: "./coord",
    draftPlan: "",
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--coord":
        out.coordDir = requireValue(argv, ++i, arg);
        break;
      case "--draft-plan":
      case "--from-draft-plan":
        out.draftPlan = requireValue(argv, ++i, arg);
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
  if (!out.draftPlan) {
    throw new Error(`--draft-plan is required.\n\n${usage()}`);
  }
  return out;
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`Unable to read ${label} JSON at ${file}: ${err.message}`);
  }
}

function readOptionalJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {
    return {};
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

function resolveFrom(cwd, maybeRelative) {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(cwd, maybeRelative);
}

function formatList(items) {
  return (items || []).map((item) => `  - ${item}`).join("\n");
}

function usage() {
  return [
    "Usage:",
    "  node scripts/materialize-plan.js --draft-plan ./coord/plan-reviews/draft-plan-v1.json [--coord ./coord] [--force]",
    "",
    "Writes coord/context.json, coord/DECISIONS.md, and coord/CALLER_CONTEXT.md from a reviewed draft plan.",
    "Use --force to overwrite an existing context.json task map.",
  ].join("\n");
}

module.exports = {
  buildContextFromDraftPlan,
  buildCallerContextMarkdown,
  buildDecisionsMarkdown,
  parseArgs,
  runMaterializePlan,
};
