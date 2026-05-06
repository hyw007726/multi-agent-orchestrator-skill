#!/usr/bin/env node
const { execSync } = require('child_process');

console.log("Setting up multi-agent orchestrator dependencies...");

// 1. Local dependencies — required for all orchestration scripts.
console.log("Installing local skill dependencies...");
try {
  execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
} catch (err) {
  console.error("Local npm install failed:", err.message);
  process.exit(1);
}

// 2. Global ts-node + typescript — needed so `npx ts-node` works from any
// project directory, not just from inside the skill folder.
// Skip if already on PATH to avoid a redundant (slow) global install each run.
function isOnPath(bin) {
  try { execSync(`which ${bin}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

if (isOnPath('ts-node') && isOnPath('tsc')) {
  console.log("\nts-node and typescript already on PATH — skipping global install.");
} else {
  console.log("\nInstalling ts-node and typescript globally...");
  try {
    execSync('npm install -g typescript ts-node', { stdio: 'inherit' });
  } catch {
    // Non-fatal: local node_modules has ts-node as a devDep, so npx may still
    // resolve it. Print remediation and let the caller decide whether to abort.
    console.warn("\n⚠  Global install failed (likely a permissions issue).");
    console.warn("   Fix: sudo npm install -g typescript ts-node");
    console.warn("   Or, if using nvm/fnm, ensure your active Node version's prefix is writable.");
    console.warn("   npx ts-node may still work via local node_modules — try proceeding.");
  }
}

console.log("\nSetup complete!");
