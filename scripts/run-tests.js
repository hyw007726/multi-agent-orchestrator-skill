#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let failed = false;
const COVERAGE_THRESHOLDS = {
  lines: 85,
  branches: 64,
  functions: 90,
};

console.log("Syntax checks...");
const scriptFiles = collectJsFiles("scripts");
scriptFiles.push(...collectJsFiles("tests"));

for (const file of scriptFiles) {
  const r = spawnSync("node", ["--check", file], { cwd: ROOT, encoding: "utf-8" });
  if (r.status === 0) {
    console.log(`  OK   ${file}`);
  } else {
    console.error(`  FAIL ${file}`);
    if (r.stderr) process.stderr.write(r.stderr);
    failed = true;
  }
}

console.log("\nSmoke tests...");
const testsDir = path.join(ROOT, "tests");
const testFiles = (() => {
  try { return fs.readdirSync(testsDir).filter(f => f.endsWith(".test.js")); }
  catch { return []; }
})();

if (testFiles.length === 0) {
  console.log("  No .test.js files found in tests/ yet.");
} else {
  const result = spawnSync("node", [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=scripts/**/*.js",
    "--test-coverage-exclude=scripts/run-tests.js",
    `--test-coverage-lines=${COVERAGE_THRESHOLDS.lines}`,
    `--test-coverage-branches=${COVERAGE_THRESHOLDS.branches}`,
    `--test-coverage-functions=${COVERAGE_THRESHOLDS.functions}`,
    ...testFiles.map(f => path.join("tests", f)),
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);

function collectJsFiles(relativeDir) {
  const dir = path.join(ROOT, relativeDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(relativePath);
    }
  }
  return out;
}
