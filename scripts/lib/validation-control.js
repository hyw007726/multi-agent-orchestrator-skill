const fs = require("fs");
const { writeAtomic } = require("./locking");

const VALIDATION_STATE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PASSED: "passed",
  FAILED: "failed",
});
// Hard cap on runValidation: even if every configurable timeout is missing or 0,
// a hung validation suite must not freeze the main loop and starve other agents.
const VALIDATION_HARD_CAP_MINS = 30;

function validationTimeout(agent, parsedConfig = {}) {
  const configured = firstPositiveNumber(agent.validation_timeout_mins, agent.timeout_mins, parsedConfig.default_timeout_mins);
  // Never return null: a hung validation suite would block the whole loop and
  // starve every other agent. Fall back to a generous hard cap if config is missing or 0.
  const mins = configured ?? VALIDATION_HARD_CAP_MINS;
  return {
    mins,
    ms: Math.max(1, Math.ceil(mins * 60_000)),
    fromHardCap: configured === null,
  };
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function formatValidationTimeout(timeout) {
  return `${timeout.ms}ms (${timeout.mins} minute${timeout.mins === 1 ? "" : "s"})`;
}

function hasValidationCommand(cmd) {
  if (!cmd || cmd === "null") return false;
  if (Array.isArray(cmd) && cmd.length === 0) return false;
  return true;
}

function formatValidationCommandForLog(cmd) {
  return Array.isArray(cmd) ? cmd.join(" ") : String(cmd);
}

function isValidationRunning(agent) {
  return agent &&
    agent.validation &&
    agent.validation.state === VALIDATION_STATE.RUNNING;
}

function readValidationResult(validation) {
  if (!validation || !validation.result_file || !fs.existsSync(validation.result_file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(validation.result_file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return {
      passed: false,
      log: `Validation result file is malformed: ${validation.result_file}`,
      error: "malformed validation result",
      completed_at: new Date().toISOString(),
    };
  }
}

function missingValidationResultIfStale(agent, validation, parsedConfig = {}) {
  const startedMs = Date.parse(validation.started_at || "");
  if (!Number.isFinite(startedMs)) return null;
  const timeoutMs = Number.isFinite(validation.timeout_ms)
    ? validation.timeout_ms
    : validationTimeout(agent, parsedConfig).ms;
  const pid = Number(validation.pid);
  if (Number.isInteger(pid) && pid > 0 && !processAlive(pid) && Date.now() - startedMs > 500) {
    return {
      passed: false,
      log: "Validation runner exited before writing a result.",
      error: "missing validation result",
      completed_at: new Date().toISOString(),
    };
  }
  const staleAfterMs = timeoutMs + Math.max(5000, Math.min(30_000, timeoutMs));
  if (Date.now() - startedMs > staleAfterMs) {
    return {
      passed: false,
      log: `Validation runner did not write a result within ${Math.ceil(staleAfterMs)}ms.`,
      error: "missing validation result",
      completed_at: new Date().toISOString(),
    };
  }
  return null;
}

function writeValidationResultFile(resultFile, result) {
  try {
    writeAtomic(resultFile, JSON.stringify(result, null, 2) + "\n");
  } catch {}
}

function safeValidationFileSegment(value) {
  return String(value || "agent").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "agent";
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killValidationRunner(pid, agentName, log) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGTERM");
    log(`Sent SIGTERM to validation runner for ${agentName} (PGID ${pid}).`);
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      log(`Sent SIGTERM to validation runner for ${agentName} (PID ${pid}).`);
    } catch {}
  }
}

module.exports = {
  VALIDATION_STATE,
  VALIDATION_HARD_CAP_MINS,
  validationTimeout,
  firstPositiveNumber,
  formatValidationTimeout,
  hasValidationCommand,
  formatValidationCommandForLog,
  isValidationRunning,
  readValidationResult,
  missingValidationResultIfStale,
  writeValidationResultFile,
  safeValidationFileSegment,
  processAlive,
  killValidationRunner,
};
