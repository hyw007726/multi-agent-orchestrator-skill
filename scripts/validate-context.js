#!/usr/bin/env node
"use strict";

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

  let context;
  try {
    context = readJson(contextPath);
  } catch (err) {
    console.error(`Context validation failed:\n  ERROR ${err.message}`);
    console.error("");
    console.error(`Run bootstrap first or edit ${path.relative(projectRoot, contextPath)}.`);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(projectRoot);
  } catch (err) {
    console.error(`Context validation failed:\n  ERROR Failed to load orchestrator.config.js: ${err.message}`);
    process.exit(1);
  }

  const report = validateContext(context, config, {
    projectRoot,
    coordDir: args.coordDir,
    requireLaunchable: true,
  });
  const formatted = formatValidationReport(report, {
    coordDir: args.coordDir,
    contextPath: path.relative(projectRoot, contextPath),
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
  const args = { coordDir: "./coord", help: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--coord":
        args.coordDir = argv[++i];
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

function usage() {
  return [
    "Validate multi-agent starter context before launch",
    "",
    "Options:",
    "  --coord <dir>   Coordination directory containing context.json (default: ./coord)",
    "  --help          Show this help message",
    "",
    "Example:",
    "  node scripts/validate-context.js --coord ./coord",
  ].join("\n");
}
