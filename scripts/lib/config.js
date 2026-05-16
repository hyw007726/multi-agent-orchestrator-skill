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
  opencode: { cmd: "opencode", args: ["run", "--dangerously-skip-permissions", { prompt_text: true }] },
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
  if (typeof parsed.launch_dashboard === "boolean" || parsed.launch_dashboard === "auto") {
    merged.launch_dashboard = parsed.launch_dashboard;
  }
  if (typeof parsed.launch_review_terminal === "boolean") merged.launch_review_terminal = parsed.launch_review_terminal;
  merged.max_plan_review_iterations = normalizeMaxPlanReviewIterations(parsed.max_plan_review_iterations);
  merged.reviewers = normalizeReviewers(parsed.reviewers, merged);

  return merged;
}

function mergeConfigInputs(configs) {
  const merged = {};
  for (const config of configs) {
    if (!isPlainObject(config)) continue;

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
