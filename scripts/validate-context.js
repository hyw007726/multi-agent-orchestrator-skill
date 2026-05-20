#!/usr/bin/env node
"use strict";

/**
 * Validate the coord/context.json a launch would consume.
 *
 * Usage:
 *   node scripts/validate-context.js --coord ./coord
 *   node scripts/validate-context.js --coord ./coord --json
 *
 * Default output is the human-readable validator report on stdout/stderr.
 * With --json, emits a single JSON document on stdout (no other stdout text):
 *
 *   {
 *     "ok": true | false,
 *     "errors": ["string"],
 *     "warnings": ["string"],
 *     "coord_dir": "./coord",
 *     "context_path": "coord/context.json"
 *   }
 *
 * Exit codes: 0 when no errors, 1 otherwise. Warnings alone are not a failure.
 */

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { validateContext, formatValidationReport } = require("./lib/context-validation");

runValidateContext();

function runValidateContext() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const projectRoot = process.cwd();
  const coordDir = path.resolve(projectRoot, args.coordDir);
  const contextPath = path.join(coordDir, "context.json");
  const decisionsPath = path.join(coordDir, "DECISIONS.md");
  const validateCommand = `node ${path.relative(projectRoot, __filename)} --coord ${args.coordDir}`;
  const relContextPath = path.relative(projectRoot, contextPath);

  let context;
  try {
    context = readJson(contextPath);
  } catch (err) {
    emitFatal(args.json, err.message, relContextPath, args.coordDir);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(projectRoot);
  } catch (err) {
    emitFatal(args.json, `Failed to load orchestrator config: ${err.message}`, relContextPath, args.coordDir);
    process.exit(1);
  }

  const report = validateContext(context, config, {
    projectRoot,
    coordDir: args.coordDir,
    requireLaunchable: true,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify({
      ok: report.errors.length === 0,
      errors: report.errors,
      warnings: report.warnings,
      coord_dir: args.coordDir,
      context_path: relContextPath,
    }, null, 2) + "\n");
    process.exit(report.errors.length > 0 ? 1 : 0);
  }

  const formatted = formatValidationReport(report, {
    coordDir: args.coordDir,
    contextPath: relContextPath,
    decisionsPath: path.relative(projectRoot, decisionsPath),
    validateCommand,
  });

  if (formatted) {
    const stream = report.errors.length > 0 ? process.stderr : process.stdout;
    stream.write(`${formatted}\n`);
  }

  if (report.errors.length > 0) {
    process.exit(1);
  }

  if (report.warnings.length === 0) {
    console.log("Context validation passed.");
  } else {
    console.log("Context validation passed with warnings.");
  }
}

function parseArgs() {
  const args = { coordDir: "./coord", help: false, json: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--coord":
        args.coordDir = argv[++i];
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        console.error(usage());
        process.exit(1);
    }
  }
  return args;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${filePath} not found. Run bootstrap first.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

// Emits a fatal-read error in the right channel for the chosen mode. In --json
// mode the envelope still parses cleanly; in human mode it matches the prior
// stderr layout.
function emitFatal(jsonMode, message, contextPath, coordDir) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: false,
      errors: [message],
      warnings: [],
      coord_dir: coordDir,
      context_path: contextPath,
    }, null, 2) + "\n");
    return;
  }
  console.error(`Context validation failed:\n  ERROR ${message}`);
  console.error("");
  console.error(`Run bootstrap first or edit ${contextPath}.`);
}

function usage() {
  return [
    "Validate multi-agent starter context before launch",
    "",
    "Options:",
    "  --coord <dir>   Coordination directory containing context.json (default: ./coord)",
    "  --json          Emit a single JSON document on stdout instead of human text",
    "  --help          Show this help message",
    "",
    "Example:",
    "  node scripts/validate-context.js --coord ./coord",
  ].join("\n");
}
