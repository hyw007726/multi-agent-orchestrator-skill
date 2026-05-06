const fs = require("fs");
const path = require("path");

// Default `--version`-style probes per CLI. Overridable via cli_health_checks in config.
// `--version` confirms the binary is installed and runnable; it does NOT confirm auth or
// that a default model is selected. Use the --auth flag on the preflight script for that.
const DEFAULT_HEALTH_CHECKS = {
  kilo: "kilo --version",
  aider: "aider --version",
  claude: "claude --version",
  codex: "codex --version",
  gemini: "gemini --version",
  opencode: "opencode --version",
};

const DEFAULTS = {
  default_cli: "kilo",
  orchestrator_cli: "claude",
  cli_templates: {},
  cli_health_checks: { ...DEFAULT_HEALTH_CHECKS },
  default_timeout_mins: 10,
  default_progress_timeout_mins: 15,
  default_max_restarts: 3,
  claude_failure_threshold: 5,
  poll_min_ms: 1000,
  poll_max_ms: 15000,
};

function loadConfig(cwd = process.cwd()) {
  const configPath = path.resolve(cwd, "orchestrator.config.js");
  if (!fs.existsSync(configPath)) return { ...DEFAULTS };

  const parsed = require(configPath) ?? {};

  const merged = { ...DEFAULTS };

  if (typeof parsed.default_cli === "string") merged.default_cli = parsed.default_cli;
  if (typeof parsed.orchestrator_cli === "string") merged.orchestrator_cli = parsed.orchestrator_cli;
  if (parsed.cli_templates && typeof parsed.cli_templates === "object") {
    merged.cli_templates = parsed.cli_templates;
  }
  if (parsed.cli_health_checks && typeof parsed.cli_health_checks === "object") {
    // User-provided entries override the per-CLI defaults; unspecified CLIs keep the default probe.
    merged.cli_health_checks = { ...DEFAULT_HEALTH_CHECKS, ...parsed.cli_health_checks };
  }
  if (typeof parsed.default_timeout_mins === "number") merged.default_timeout_mins = parsed.default_timeout_mins;
  if (typeof parsed.default_progress_timeout_mins === "number") merged.default_progress_timeout_mins = parsed.default_progress_timeout_mins;
  if (typeof parsed.default_max_restarts === "number") merged.default_max_restarts = parsed.default_max_restarts;
  if (typeof parsed.claude_failure_threshold === "number") merged.claude_failure_threshold = parsed.claude_failure_threshold;
  if (typeof parsed.poll_min_ms === "number") merged.poll_min_ms = parsed.poll_min_ms;
  if (typeof parsed.poll_max_ms === "number") merged.poll_max_ms = parsed.poll_max_ms;

  return merged;
}

module.exports = { loadConfig };
