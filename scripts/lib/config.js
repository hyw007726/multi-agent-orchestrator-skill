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

const DEFAULT_CLI_TEMPLATES = {
  kilo: 'kilo run "$(cat {prompt_file})" --auto',
  aider: { cmd: "aider", args: ["--message-file", { prompt_file: true }, "--yes"] },
  claude: { cmd: "claude", args: ["-p", { prompt_text: true }, "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6"] },
  gemini: { cmd: "gemini", args: ["--prompt", { prompt_text: true }, "--yolo"] },
  codex: { cmd: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox", { prompt_text: true }] },
  opencode: { cmd: "opencode", args: ["run", { prompt_text: true }, "--yes"] },
};

const DEFAULTS = {
  default_cli: "kilo",
  // If omitted, request arbitration uses the same CLI as workers. Projects that
  // want a stronger/different arbitrator should set orchestrator_cli explicitly.
  orchestrator_cli: null,
  cli_templates: { ...DEFAULT_CLI_TEMPLATES },
  cli_health_checks: { ...DEFAULT_HEALTH_CHECKS },
  default_timeout_mins: 10,
  default_progress_timeout_mins: 15,
  default_max_restarts: 3,
  orchestrator_failure_threshold: 5,
  claude_failure_threshold: 5, // Deprecated alias kept for existing project configs.
  poll_min_ms: 1000,
  poll_max_ms: 15000,
  launch_dashboard: false,
  launch_review_terminal: false,
};

function defaultConfig() {
  const config = {
    ...DEFAULTS,
    cli_templates: { ...DEFAULT_CLI_TEMPLATES },
    cli_health_checks: { ...DEFAULT_HEALTH_CHECKS },
  };
  config.orchestrator_cli = config.default_cli;
  return config;
}

function loadConfig(cwd = process.cwd()) {
  const configPath = path.resolve(cwd, "orchestrator.config.js");
  if (!fs.existsSync(configPath)) return defaultConfig();

  const parsed = require(configPath) ?? {};

  const merged = defaultConfig();

  if (typeof parsed.default_cli === "string") merged.default_cli = parsed.default_cli;
  const hasExplicitOrchestratorCli = typeof parsed.orchestrator_cli === "string" && parsed.orchestrator_cli.trim() !== "";
  if (hasExplicitOrchestratorCli) merged.orchestrator_cli = parsed.orchestrator_cli;
  else merged.orchestrator_cli = merged.default_cli;
  if (parsed.cli_templates && typeof parsed.cli_templates === "object") {
    // Project-level entries override built-ins; omitted CLIs keep usable defaults.
    merged.cli_templates = { ...DEFAULT_CLI_TEMPLATES, ...parsed.cli_templates };
  }
  if (parsed.cli_health_checks && typeof parsed.cli_health_checks === "object") {
    // User-provided entries override the per-CLI defaults; unspecified CLIs keep the default probe.
    merged.cli_health_checks = { ...DEFAULT_HEALTH_CHECKS, ...parsed.cli_health_checks };
  }
  if (typeof parsed.default_timeout_mins === "number") merged.default_timeout_mins = parsed.default_timeout_mins;
  if (typeof parsed.default_progress_timeout_mins === "number") merged.default_progress_timeout_mins = parsed.default_progress_timeout_mins;
  if (typeof parsed.default_max_restarts === "number") merged.default_max_restarts = parsed.default_max_restarts;
  if (typeof parsed.orchestrator_failure_threshold === "number") {
    merged.orchestrator_failure_threshold = parsed.orchestrator_failure_threshold;
  } else if (typeof parsed.claude_failure_threshold === "number") {
    merged.orchestrator_failure_threshold = parsed.claude_failure_threshold;
  }
  merged.claude_failure_threshold = merged.orchestrator_failure_threshold;
  if (typeof parsed.poll_min_ms === "number") merged.poll_min_ms = parsed.poll_min_ms;
  if (typeof parsed.poll_max_ms === "number") merged.poll_max_ms = parsed.poll_max_ms;
  if (typeof parsed.launch_dashboard === "boolean") merged.launch_dashboard = parsed.launch_dashboard;
  if (typeof parsed.launch_review_terminal === "boolean") merged.launch_review_terminal = parsed.launch_review_terminal;

  return merged;
}

module.exports = { loadConfig };
