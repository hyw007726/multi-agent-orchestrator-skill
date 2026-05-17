const fs = require("fs");
const path = require("path");

const CONFIG_FILENAMES = [
  "orchestrator.config.jsonc",
  "orchestrator.config.json",
  "orchestrator.config.js",
];

const LOCAL_CONFIG_FILENAMES = [
  "orchestrator.config.local.jsonc",
  "orchestrator.config.local.json",
];

const SUPPORTED_CONFIG_KEYS = new Set([
  "$schema",
  "default_cli",
  "orchestrator_cli",
  "cli_templates",
  "cli_health_checks",
  "reviewers",
  "max_plan_review_iterations",
  "default_timeout_mins",
  "default_progress_timeout_mins",
  "orchestrator_cli_timeout_ms",
  "default_max_restarts",
  "orchestrator_failure_threshold",
  "claude_failure_threshold",
  "poll_min_ms",
  "poll_max_ms",
  "launch_dashboard",
  "launch_review_terminal",
]);

const REVIEWER_KEYS = new Set([
  "name",
  "cli",
  "review_focus",
  "model",
  "model_flag",
  "template_args",
  "extra_args",
  "timeout_mins",
]);

// Default `--version`-style probes per CLI. Overridable via cli_health_checks in config.
// `--version` confirms the binary is installed and runnable; it does NOT confirm auth or
// that a default model is selected. Use the --auth flag on the preflight script for that.
const DEFAULT_HEALTH_CHECKS = {
  claude: "claude --version",
  codex: "codex --version",
  gemini: "gemini --version",
  kilo: "kilo --version",
  opencode: "opencode --version",
};

// Prompt transport audit:
// - claude, codex, and gemini read non-interactive prompts from stdin.
//   Gemini still needs --prompt to select headless mode; the empty value keeps
//   the real prompt out of argv and lets stdin carry it.
// - kilo and opencode accept prompt files via --file attachments.
// Keep defaults off prompt_text so large prompts do not appear in argv or hit ARG_MAX.
const DEFAULT_CLI_TEMPLATES = {
  claude: { cmd: "claude", args: ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--model", "claude-sonnet-4-6"], stdin: { prompt_file: true } },
  codex: { cmd: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox"], stdin: { prompt_file: true } },
  gemini: { cmd: "gemini", args: ["--prompt", "", "--yolo", "--output-format", "stream-json"], stdin: { prompt_file: true } },
  kilo: { cmd: "kilo", args: ["run", "--file", { prompt_file: true }, "Follow the instructions in the attached prompt file.", "--auto"] },
  opencode: { cmd: "opencode", args: ["run", "--dangerously-skip-permissions", "--file", { prompt_file: true }, "Follow the instructions in the attached prompt file."] },
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
  orchestrator_cli_timeout_ms: 120000,
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
  return config;
}

function loadConfig(cwd = process.cwd()) {
  const configPaths = findConfigPaths(cwd);
  if (configPaths.length === 0) return defaultConfig();

  const parsed = mergeConfigInputs(configPaths.map((configPath) => loadProjectConfig(configPath)));
  return normalizeConfig(parsed);
}

function normalizeConfig(parsed = {}) {
  assertPlainConfigObject(parsed);
  rejectUnsupportedConfigKeys(parsed);

  const merged = defaultConfig();
  if (hasOwn(parsed, "default_cli")) {
    merged.default_cli = normalizeNonEmptyString(parsed.default_cli, "default_cli");
  }
  if (hasOwn(parsed, "orchestrator_cli") && parsed.orchestrator_cli !== null) {
    merged.orchestrator_cli = normalizeNonEmptyString(parsed.orchestrator_cli, "orchestrator_cli");
  } else {
    merged.orchestrator_cli = merged.default_cli;
  }
  if (hasOwn(parsed, "cli_templates")) {
    if (!isPlainObject(parsed.cli_templates)) {
      throw new Error("cli_templates must be an object mapping CLI names to shell strings or { cmd, args } templates. Remove it to use the built-in templates.");
    }
    // Project-level entries override built-ins; omitted CLIs keep usable defaults.
    merged.cli_templates = { ...DEFAULT_CLI_TEMPLATES, ...parsed.cli_templates };
  }
  if (hasOwn(parsed, "cli_health_checks")) {
    if (!isPlainObject(parsed.cli_health_checks)) {
      throw new Error("cli_health_checks must be an object mapping CLI names to non-empty shell command strings. Remove it to use the built-in health checks.");
    }
    for (const [cli, command] of Object.entries(parsed.cli_health_checks)) {
      normalizeNonEmptyString(command, `cli_health_checks.${cli}`);
    }
    // User-provided entries override the per-CLI defaults; unspecified CLIs keep the default probe.
    merged.cli_health_checks = { ...DEFAULT_HEALTH_CHECKS, ...parsed.cli_health_checks };
  }
  if (hasOwn(parsed, "default_timeout_mins")) {
    merged.default_timeout_mins = normalizePositiveNumber(parsed.default_timeout_mins, "default_timeout_mins", "minutes");
  }
  if (hasOwn(parsed, "default_progress_timeout_mins")) {
    merged.default_progress_timeout_mins = normalizePositiveNumber(parsed.default_progress_timeout_mins, "default_progress_timeout_mins", "minutes");
  }
  if (hasOwn(parsed, "orchestrator_cli_timeout_ms")) {
    merged.orchestrator_cli_timeout_ms = normalizePositiveInteger(parsed.orchestrator_cli_timeout_ms, "orchestrator_cli_timeout_ms", "milliseconds");
  }
  if (hasOwn(parsed, "default_max_restarts")) {
    merged.default_max_restarts = normalizeNonNegativeInteger(parsed.default_max_restarts, "default_max_restarts");
  }
  const hasFailureThreshold = hasOwn(parsed, "orchestrator_failure_threshold");
  const hasDeprecatedFailureThreshold = hasOwn(parsed, "claude_failure_threshold");
  if (hasFailureThreshold) {
    merged.orchestrator_failure_threshold = normalizePositiveInteger(parsed.orchestrator_failure_threshold, "orchestrator_failure_threshold");
  }
  if (hasDeprecatedFailureThreshold) {
    const aliasValue = normalizePositiveInteger(parsed.claude_failure_threshold, "claude_failure_threshold");
    if (!hasFailureThreshold) merged.orchestrator_failure_threshold = aliasValue;
  }
  merged.claude_failure_threshold = merged.orchestrator_failure_threshold;
  if (hasOwn(parsed, "poll_min_ms")) {
    merged.poll_min_ms = normalizePositiveInteger(parsed.poll_min_ms, "poll_min_ms", "milliseconds");
  }
  if (hasOwn(parsed, "poll_max_ms")) {
    merged.poll_max_ms = normalizePositiveInteger(parsed.poll_max_ms, "poll_max_ms", "milliseconds");
  }
  if (merged.poll_min_ms > merged.poll_max_ms) {
    throw new Error(`poll_min_ms (${merged.poll_min_ms}) must be less than or equal to poll_max_ms (${merged.poll_max_ms}). Lower poll_min_ms or raise poll_max_ms.`);
  }
  if (hasOwn(parsed, "launch_dashboard")) {
    merged.launch_dashboard = normalizeLaunchDashboard(parsed.launch_dashboard);
  }
  if (hasOwn(parsed, "launch_review_terminal")) {
    if (typeof parsed.launch_review_terminal !== "boolean") {
      throw new Error("launch_review_terminal must be a boolean. Set it to true, false, or remove it to use false.");
    }
    merged.launch_review_terminal = parsed.launch_review_terminal;
  }
  merged.max_plan_review_iterations = normalizeMaxPlanReviewIterations(parsed.max_plan_review_iterations);
  merged.reviewers = normalizeReviewers(parsed.reviewers, merged);

  return merged;
}

function mergeConfigInputs(configs) {
  const merged = {};
  for (const config of configs) {
    if (!isPlainObject(config)) {
      throw new Error("orchestrator config must export or parse to an object.");
    }

    const hasCliTemplates = hasOwn(config, "cli_templates");
    const hasCliHealthChecks = hasOwn(config, "cli_health_checks");
    if (hasCliTemplates && !isPlainObject(config.cli_templates)) {
      throw new Error("cli_templates must be an object mapping CLI names to shell strings or { cmd, args } templates. Remove it to use the built-in templates.");
    }
    if (hasCliHealthChecks && !isPlainObject(config.cli_health_checks)) {
      throw new Error("cli_health_checks must be an object mapping CLI names to non-empty shell command strings. Remove it to use the built-in health checks.");
    }
    const cliTemplates = isPlainObject(config.cli_templates) ? config.cli_templates : undefined;
    const cliHealthChecks = isPlainObject(config.cli_health_checks) ? config.cli_health_checks : undefined;
    const previousCliTemplates = isPlainObject(merged.cli_templates) ? merged.cli_templates : {};
    const previousCliHealthChecks = isPlainObject(merged.cli_health_checks) ? merged.cli_health_checks : {};
    const { cli_templates: _cliTemplates, cli_health_checks: _cliHealthChecks, ...rest } = config;

    Object.assign(merged, rest);
    if (cliTemplates) {
      merged.cli_templates = {
        ...previousCliTemplates,
        ...cliTemplates,
      };
    }
    if (cliHealthChecks) {
      merged.cli_health_checks = {
        ...previousCliHealthChecks,
        ...cliHealthChecks,
      };
    }
  }
  return merged;
}

function findConfigPath(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(root, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findLocalConfigPath(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  for (const filename of LOCAL_CONFIG_FILENAMES) {
    const candidate = path.join(root, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findConfigPaths(cwd = process.cwd()) {
  return [findConfigPath(cwd), findLocalConfigPath(cwd)].filter(Boolean);
}

function loadProjectConfig(configPath) {
  const ext = path.extname(configPath);
  if (ext === ".js" || ext === ".cjs") return require(configPath);
  if (ext === ".json" || ext === ".jsonc") {
    const source = fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    return JSON.parse(stripJsonc(source));
  }
  throw new Error(`Unsupported config file extension for ${path.basename(configPath)}.`);
}

function stripJsonc(source) {
  return stripTrailingCommas(stripJsonComments(source));
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      if (i < source.length) {
        output += source[i];
        if (source[i] === "\r" && source[i + 1] === "\n") output += source[++i];
      }
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i++;
          break;
        }
        if (source[i] === "\n" || source[i] === "\r") output += source[i];
        i++;
      }
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] === "}" || source[j] === "]") continue;
    }

    output += char;
  }

  return output;
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
    rejectUnsupportedReviewerKeys(entry, index);

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

function assertPlainConfigObject(value) {
  if (!isPlainObject(value)) {
    throw new Error("orchestrator config must export or parse to an object.");
  }
}

function rejectUnsupportedConfigKeys(config) {
  for (const key of Object.keys(config)) {
    if (!SUPPORTED_CONFIG_KEYS.has(key)) {
      throw new Error(`Unsupported config key '${key}'. Remove it, or add it to references/orchestrator-config.schema.json and scripts/lib/config.js before using it.`);
    }
  }
}

function rejectUnsupportedReviewerKeys(entry, index) {
  for (const key of Object.keys(entry)) {
    if (!REVIEWER_KEYS.has(key)) {
      throw new Error(`reviewers[${index}].${key} is not supported. Remove it, or add it to the reviewer schema and normalizeReviewers().`);
    }
  }
}

function normalizePositiveNumber(value, label, units = "value") {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number (${units}). Set ${label} to a value greater than 0, or remove it to use the default.`);
  }
  return value;
}

function normalizePositiveInteger(value, label, units = "value") {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer (${units}). Set ${label} to 1 or greater, or remove it to use the default.`);
  }
  return value;
}

function normalizeNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer. Set ${label} to 0 or greater, or remove it to use the default.`);
  }
  return value;
}

function normalizeLaunchDashboard(value) {
  if (value === "auto" || typeof value === "boolean") return value;
  throw new Error('launch_dashboard must be "auto", true, or false. Use "auto" for local macOS auto-launch behavior, or remove it to use "auto".');
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

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

module.exports = {
  CONFIG_FILENAMES,
  LOCAL_CONFIG_FILENAMES,
  findConfigPath,
  findConfigPaths,
  findLocalConfigPath,
  loadConfig,
  mergeConfigInputs,
  normalizeMaxPlanReviewIterations,
  normalizeReviewers,
  normalizeConfig,
  stripJsonc,
};
