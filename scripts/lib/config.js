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
  // If omitted, initial draft-plan generation uses the same CLI as request arbitration.
  planner_cli: null,
  cli_templates: { ...DEFAULT_CLI_TEMPLATES },
  cli_health_checks: { ...DEFAULT_HEALTH_CHECKS },
  default_timeout_mins: 10,
  default_progress_timeout_mins: 15,
  default_max_restarts: 3,
  orchestrator_failure_threshold: 5,
  claude_failure_threshold: 5, // Deprecated alias kept for existing project configs.
  poll_min_ms: 1000,
  poll_max_ms: 15000,
  launch_dashboard: "auto",
  launch_review_terminal: false,
  reviewers: [],
  max_plan_review_iterations: "auto",
};

function defaultConfig() {
  const config = {
    ...DEFAULTS,
    cli_templates: { ...DEFAULT_CLI_TEMPLATES },
    cli_health_checks: { ...DEFAULT_HEALTH_CHECKS },
    reviewers: [],
  };
  config.orchestrator_cli = config.default_cli;
  config.planner_cli = config.orchestrator_cli;
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
  if (typeof parsed.planner_cli === "string" && parsed.planner_cli.trim() !== "") {
    merged.planner_cli = parsed.planner_cli;
  } else {
    merged.planner_cli = merged.orchestrator_cli;
  }
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
  if (typeof parsed.launch_dashboard === "boolean" || parsed.launch_dashboard === "auto") {
    merged.launch_dashboard = parsed.launch_dashboard;
  }
  if (typeof parsed.launch_review_terminal === "boolean") merged.launch_review_terminal = parsed.launch_review_terminal;
  merged.max_plan_review_iterations = normalizeMaxPlanReviewIterations(parsed.max_plan_review_iterations);
  merged.reviewers = normalizeReviewers(parsed.reviewers, merged);

  return merged;
}

function normalizeMaxPlanReviewIterations(value) {
  if (value === undefined) return "auto";
  if (value === "auto") return "auto";
  if (Number.isInteger(value) && value > 0) return value;
  throw new Error('max_plan_review_iterations must be "auto" or a positive integer.');
}

function normalizeReviewers(value, config) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("reviewers must be an array when configured.");
  }

  const seen = new Set();
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`reviewers[${index}] must be an object.`);
    }

    const name = normalizeNonEmptyString(entry.name, `reviewers[${index}].name`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`reviewers[${index}].name must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.`);
    }
    if (seen.has(name)) {
      throw new Error(`reviewers[${index}].name duplicates reviewer '${name}'.`);
    }
    seen.add(name);

    const cli = normalizeNonEmptyString(entry.cli, `reviewers[${index}].cli`);
    if (config.cli_templates[cli] === undefined) {
      throw new Error(`reviewers[${index}].cli '${cli}' has no matching cli_templates.${cli} entry.`);
    }
    if (config.cli_health_checks[cli] === undefined) {
      throw new Error(`reviewers[${index}].cli '${cli}' has no matching cli_health_checks.${cli} entry.`);
    }

    const reviewFocus = normalizeNonEmptyString(entry.review_focus, `reviewers[${index}].review_focus`);
    const reviewer = {
      name,
      cli,
      review_focus: reviewFocus,
    };

    if (entry.model !== undefined) {
      reviewer.model = normalizeNonEmptyString(entry.model, `reviewers[${index}].model`);
    }
    if (entry.model_flag !== undefined) {
      reviewer.model_flag = normalizeNonEmptyString(entry.model_flag, `reviewers[${index}].model_flag`);
    }
    if (entry.template_args !== undefined) {
      reviewer.template_args = normalizeStringArray(entry.template_args, `reviewers[${index}].template_args`);
    } else if (entry.extra_args !== undefined) {
      reviewer.template_args = normalizeStringArray(entry.extra_args, `reviewers[${index}].extra_args`);
    }
    if (entry.timeout_mins !== undefined) {
      if (!Number.isFinite(entry.timeout_mins) || entry.timeout_mins <= 0) {
        throw new Error(`reviewers[${index}].timeout_mins must be a positive number.`);
      }
      reviewer.timeout_mins = entry.timeout_mins;
    }

    return reviewer;
  });
}

function normalizeNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }
    return item;
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  loadConfig,
  normalizeMaxPlanReviewIterations,
  normalizeReviewers,
};
