const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { validateCliTemplate } = require("./cli-template");

const VALID_EXECUTION_MODES = new Set(["direct", "single_worker", "parallel", "phased"]);
const LAUNCHABLE_EXECUTION_MODES = new Set(["single_worker", "parallel", "phased"]);
const VALID_FOUNDATION_STATUSES = new Set(["not_required", "completed_committed", "owned_by_worker"]);
const SAFE_TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BROAD_PATTERNS = new Set([".", "./", "*", "./*", "**", "./**", "**/*", "./**/*"]);

const COMMON_FOUNDATION_PATHS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.js",
  "vite.config.ts",
  "webpack.config.js",
  "rollup.config.js",
  "jest.config.js",
  "eslint.config.js",
  ".eslintrc",
  ".eslintrc.js",
  ".gitignore",
  "orchestrator.config.jsonc",
  "orchestrator.config.json",
  "orchestrator.config.local.jsonc",
  "orchestrator.config.local.json",
  "orchestrator.config.js",
];

function validateContext(context, config, options = {}) {
  const errors = [];
  const warnings = [];
  const projectRoot = options.projectRoot || process.cwd();
  const coordDir = options.coordDir || "./coord";
  const requireLaunchable = options.requireLaunchable !== false;

  if (!isPlainObject(context)) {
    errors.push("context.json must contain a JSON object.");
    return { ok: false, errors, warnings };
  }

  const topology = context.execution_topology;
  let executionMode = "";
  if (!isPlainObject(topology)) {
    errors.push("context.json execution_topology.execution_mode is required. Expected direct, single_worker, parallel, or phased; execution_topology must be an object.");
  } else {
    executionMode = normalizeString(topology.execution_mode);
    if (!executionMode) {
      errors.push("context.json execution_topology.execution_mode is required. Expected direct, single_worker, parallel, or phased.");
    } else if (!VALID_EXECUTION_MODES.has(executionMode)) {
      errors.push(`context.json execution_topology.execution_mode "${executionMode}" is invalid. Expected direct, single_worker, parallel, or phased.`);
    } else if (requireLaunchable && executionMode === "direct") {
      errors.push('context.json execution_topology.execution_mode is "direct"; handle this task in the caller session instead of launching workers.');
    }

    if (!normalizeString(topology.reason)) {
      warnings.push("execution_topology.reason is empty. Add the topology rationale so later sessions know why this mode was chosen.");
    }
    if (!Array.isArray(topology.dependency_notes)) {
      warnings.push("execution_topology.dependency_notes should be an array, even when there are no dependencies.");
    }
  }

  const tasks = context.tasks;
  if (!isPlainObject(tasks)) {
    errors.push("context.json tasks is required and must be an object keyed by agent name.");
    return { ok: false, errors, warnings };
  }

  const taskNames = Object.keys(tasks);
  if (requireLaunchable && taskNames.length === 0) {
    errors.push("context.json tasks must contain at least one task before launching workers.");
  }
  if (executionMode === "single_worker" && taskNames.length !== 1) {
    errors.push(`execution_mode "single_worker" requires exactly one task, but context.json has ${taskNames.length}.`);
  }
  if ((executionMode === "parallel" || executionMode === "phased") && taskNames.length < 2) {
    warnings.push(`execution_mode "${executionMode}" usually needs at least two independent worker tasks; use single_worker if this is sequential.`);
  }

  const foundation = validateFoundationRecord(context.foundation, taskNames, executionMode, requireLaunchable, errors, warnings);

  const resolvedTasks = [];
  for (const taskName of taskNames) {
    validateTaskName(taskName, errors);
    const task = tasks[taskName];
    if (!isPlainObject(task)) {
      errors.push(`tasks.${taskName} must be an object.`);
      continue;
    }

    validateTaskRecord(taskName, task, config, errors, warnings);
    resolvedTasks.push({
      name: taskName,
      allowedPaths: normalizePathList(task.allowed_paths),
      forbiddenPaths: normalizePathList(task.forbidden_paths),
    });
  }

  validateOwnershipRisks(resolvedTasks, executionMode, warnings);
  validateFoundationSafety(resolvedTasks, executionMode, projectRoot, coordDir, foundation, requireLaunchable, errors, warnings);
  validateCompletedFoundationGitState(foundation, projectRoot, errors);

  return { ok: errors.length === 0, errors, warnings };
}

function validateTaskName(taskName, errors) {
  if (!SAFE_TASK_NAME.test(taskName)) {
    errors.push(`Task name "${taskName}" is not safe for branch/worktree creation. Use letters, numbers, dot, underscore, or dash, starting with a letter or number.`);
  }
}

function validateTaskRecord(taskName, task, config, errors, warnings) {
  if (!normalizeString(task.description)) {
    errors.push(`tasks.${taskName}.description is required and must be a non-empty string.`);
  }

  const cli = normalizeString(task.cli) || normalizeString(config.default_cli);
  if (!cli) {
    errors.push(`tasks.${taskName}.cli is missing and config.default_cli is not set.`);
  } else if (!config.cli_templates || config.cli_templates[cli] === undefined) {
    errors.push(`tasks.${taskName}.cli "${cli}" has no cli_templates.${cli} entry. Add it to orchestrator.config.jsonc or choose a configured CLI.`);
  } else {
    const templateValidation = validateCliTemplate(cli, config.cli_templates[cli]);
    if (!templateValidation.ok) {
      errors.push(`tasks.${taskName}.cli "${cli}" has an invalid template: ${templateValidation.message}`);
    }
    if (!config.cli_health_checks || config.cli_health_checks[cli] === undefined) {
      errors.push(`tasks.${taskName}.cli "${cli}" has no cli_health_checks.${cli} entry. Add a health check so preflight can verify this worker CLI or alias before launch.`);
    }
  }

  validateStringArray(task.allowed_paths, `tasks.${taskName}.allowed_paths`, {
    required: true,
    minLength: 1,
  }, errors);
  validateStringArray(task.forbidden_paths, `tasks.${taskName}.forbidden_paths`, {
    required: false,
  }, errors);
  validateStringArray(task.read_first, `tasks.${taskName}.read_first`, {
    required: false,
  }, errors);
  validateStringArray(task.relevant_files, `tasks.${taskName}.relevant_files`, {
    required: false,
  }, errors);

  validateValidationCommand(task.validation_command, `tasks.${taskName}.validation_command`, errors, warnings);
  validatePositiveNumber(task.timeout_mins, `tasks.${taskName}.timeout_mins`, errors);
  validatePositiveNumber(task.validation_timeout_mins, `tasks.${taskName}.validation_timeout_mins`, errors);
  validatePositiveNumber(task.progress_timeout_mins, `tasks.${taskName}.progress_timeout_mins`, errors);
}

function validateStringArray(value, label, options, errors) {
  if (value === undefined) {
    if (options.required) errors.push(`${label} is required and must be a non-empty array of path strings.`);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings.`);
    return;
  }
  if (options.minLength && value.length < options.minLength) {
    errors.push(`${label} must contain at least ${options.minLength} path.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${label}[${index}] must be a non-empty string.`);
    }
  });
}

function validateValidationCommand(value, label, errors, warnings) {
  if (value === undefined) {
    warnings.push(`${label} is omitted. Set it to a JSON argv array, a shell command string, or null when automated validation is not possible.`);
    return;
  }
  if (value === null) return;

  if (Array.isArray(value)) {
    if (value.length === 0) {
      errors.push(`${label} must not be an empty argv array; use null if no validation is possible.`);
      return;
    }
    value.forEach((item, index) => {
      if (typeof item !== "string" || item.trim() === "") {
        errors.push(`${label}[${index}] must be a non-empty string.`);
      }
    });
    return;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      errors.push(`${label} must not be an empty string; use null if no validation is possible.`);
      return;
    }
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.trim() === "")) {
          errors.push(`${label} looks like JSON but is not an array of non-empty strings.`);
        }
      } catch (err) {
        errors.push(`${label} looks like JSON argv but cannot be parsed: ${err.message}`);
      }
      return;
    }
    warnings.push(`${label} is a shell string. Prefer a JSON argv array unless shell expansion is required.`);
    return;
  }

  errors.push(`${label} must be a JSON argv array, a shell command string, or null.`);
}

function validatePositiveNumber(value, label, errors) {
  if (value === undefined || value === null) return;
  if (!Number.isFinite(value) || value <= 0) {
    errors.push(`${label} must be a positive number when provided.`);
  }
}

function validateOwnershipRisks(tasks, executionMode, warnings) {
  if (tasks.length === 0) return;

  for (const task of tasks) {
    for (const allowed of task.allowedPaths) {
      for (const forbidden of task.forbiddenPaths) {
        if (patternsOverlap(allowed, forbidden)) {
          warnings.push(`tasks.${task.name} allows "${allowed.raw}" and forbids "${forbidden.raw}". Make sure the narrower rule is intentional and documented in DECISIONS.md.`);
        }
      }
    }
  }

  if (executionMode !== "parallel" && executionMode !== "phased") return;

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      for (const left of tasks[i].allowedPaths) {
        for (const right of tasks[j].allowedPaths) {
          if (patternsOverlap(left, right)) {
            warnings.push(`Possible overlapping ownership: tasks.${tasks[i].name}.allowed_paths "${left.raw}" overlaps tasks.${tasks[j].name}.allowed_paths "${right.raw}". Narrow the paths before launch if these workers are meant to run independently.`);
          }
        }
      }
    }
  }

  const broadUsage = new Map();
  for (const task of tasks) {
    for (const allowed of task.allowedPaths) {
      if (!allowed.broad && !allowed.hasGlob) continue;
      const key = allowed.normalized;
      if (!broadUsage.has(key)) broadUsage.set(key, []);
      broadUsage.get(key).push(task.name);
    }
  }
  for (const [pattern, names] of broadUsage.entries()) {
    if (names.length > 1) {
      warnings.push(`Broad allowed path "${pattern}" is shared by ${names.length} workers (${names.join(", ")}). Broad shared globs often create merge conflicts.`);
    }
  }
}

function validateFoundationRecord(value, taskNames, executionMode, requireLaunchable, errors, warnings) {
  const fanoutMode = executionMode === "parallel" || executionMode === "phased";
  const target = requireLaunchable ? errors : warnings;
  if (value === undefined) {
    if (fanoutMode) {
      target.push("context.json foundation is required for parallel/phased runs. Set foundation.status to not_required, completed_committed, or owned_by_worker before launch.");
    }
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push("context.json foundation must be an object with status, paths, and optional commit/owner.");
    return null;
  }

  const status = normalizeString(value.status);
  if (!VALID_FOUNDATION_STATUSES.has(status)) {
    errors.push("context.json foundation.status must be not_required, completed_committed, or owned_by_worker.");
  }
  validateStringArray(value.paths, "foundation.paths", { required: true }, errors);
  const paths = compactStringList(value.paths);
  const commit = normalizeString(value.commit);
  const owner = normalizeString(value.owner);

  if (value.commit !== undefined && typeof value.commit !== "string") {
    errors.push("foundation.commit must be a string when provided.");
  }
  if (value.owner !== undefined && typeof value.owner !== "string") {
    errors.push("foundation.owner must be a string when provided.");
  }

  if (status === "not_required") {
    if (paths.length > 0) {
      errors.push("foundation.paths must be empty when foundation.status is not_required.");
    }
    if (commit) {
      errors.push("foundation.commit must be empty when foundation.status is not_required.");
    }
    if (owner) {
      errors.push("foundation.owner must be empty when foundation.status is not_required.");
    }
  }

  if (status === "completed_committed") {
    if (paths.length === 0) {
      errors.push("foundation.paths must list committed foundation paths when foundation.status is completed_committed.");
    }
    if (!commit) {
      errors.push("foundation.commit is required when foundation.status is completed_committed.");
    }
    if (owner) {
      errors.push("foundation.owner must be empty when foundation.status is completed_committed.");
    }
  }

  if (status === "owned_by_worker") {
    if (paths.length === 0) {
      errors.push("foundation.paths must list worker-owned foundation paths when foundation.status is owned_by_worker.");
    }
    if (!owner) {
      errors.push("foundation.owner is required when foundation.status is owned_by_worker.");
    } else if (!taskNames.includes(owner)) {
      errors.push(`foundation.owner "${owner}" must match one of the task names.`);
    }
    if (commit) {
      errors.push("foundation.commit must be empty when foundation.status is owned_by_worker.");
    }
  }

  return { status, paths, commit, owner };
}

function validateFoundationSafety(tasks, executionMode, projectRoot, coordDir, foundation, requireLaunchable, errors, warnings) {
  if ((executionMode !== "parallel" && executionMode !== "phased") || tasks.length < 2) return;

  const sink = requireLaunchable ? errors : warnings;
  const commonFoundations = existingFoundationPaths(projectRoot, coordDir);
  const declaredFoundations = foundation ? foundation.paths : [];
  const foundations = mergeFoundationPaths(commonFoundations, declaredFoundations);
  if (foundations.length === 0) return;

  const ownedPaths = foundation?.status === "owned_by_worker"
    ? normalizePathList(foundation.paths)
    : [];
  const owner = foundation?.status === "owned_by_worker" ? foundation.owner : "";
  const ownerTask = owner ? tasks.find((task) => task.name === owner) : null;

  for (const foundationPath of foundations) {
    const owned = ownerTask && ownedPaths.some((ownedPath) => patternsOverlap(ownedPath, foundationPath));
    if (owned) {
      validateOwnedFoundationPath(ownerTask, foundationPath, sink);
      for (const task of tasks) {
        if (task.name === ownerTask.name) continue;
        validateForbiddenFoundationPath(task, foundationPath, sink, { ownedBy: ownerTask.name });
      }
    } else {
      for (const task of tasks) {
        validateForbiddenFoundationPath(task, foundationPath, sink);
      }
    }
  }
}

function validateOwnedFoundationPath(task, foundationPath, sink) {
  const allowed = task.allowedPaths.some((allowedPath) => patternsOverlap(allowedPath, foundationPath));
  if (!allowed) {
    sink.push(`Foundation path "${foundationPath.raw}" is owned by ${task.name}, but tasks.${task.name}.allowed_paths does not include it.`);
  }
  const forbidden = task.forbiddenPaths.some((forbiddenPath) => patternsOverlap(forbiddenPath, foundationPath));
  if (forbidden) {
    sink.push(`Foundation path "${foundationPath.raw}" is owned by ${task.name}, but tasks.${task.name}.forbidden_paths also forbids it.`);
  }
}

function validateForbiddenFoundationPath(task, foundationPath, sink, options = {}) {
  const forbidden = task.forbiddenPaths.some((forbiddenPath) => patternsOverlap(forbiddenPath, foundationPath));
  if (forbidden) return;
  const suffix = options.ownedBy
    ? ` It is declared as owned by ${options.ownedBy}, so every other worker must forbid it.`
    : " Add it to forbidden_paths or declare exactly one foundation owner in DECISIONS.md and context.json.";
  sink.push(`Foundation path "${foundationPath.raw}" is not forbidden by tasks.${task.name}.forbidden_paths.${suffix}`);
}

function validateCompletedFoundationGitState(foundation, projectRoot, errors) {
  if (!foundation || foundation.status !== "completed_committed") return;
  if (!foundation.commit || foundation.paths.length === 0) return;

  const commit = foundation.commit;
  const commitCheck = runGit(projectRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  if (commitCheck.status !== 0) {
    errors.push(`foundation.commit "${commit}" does not resolve to a git commit.`);
    return;
  }

  const ancestorCheck = runGit(projectRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]);
  if (ancestorCheck.status !== 0) {
    errors.push(`foundation.commit "${commit}" is not an ancestor of HEAD, so worker branches may not include the committed foundation.`);
  }

  const status = runGit(projectRoot, ["status", "--porcelain", "--untracked-files=all", "--", ...foundation.paths]);
  if (status.status !== 0) {
    errors.push(`Unable to check committed foundation paths with git status: ${status.stderr || status.stdout || "unknown error"}`.trim());
    return;
  }
  const dirty = status.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (dirty.length > 0) {
    errors.push(`foundation.status is completed_committed, but listed foundation paths have uncommitted changes: ${dirty.slice(0, 6).join("; ")}${dirty.length > 6 ? "; ..." : ""}. Commit or revert these changes before launching workers.`);
  }
}

function existingFoundationPaths(projectRoot, coordDir) {
  const out = [];
  for (const rel of COMMON_FOUNDATION_PATHS) {
    if (fs.existsSync(path.join(projectRoot, rel))) out.push(rel);
  }

  const coordRel = toPosixPath(path.relative(projectRoot, path.resolve(projectRoot, coordDir))).replace(/\/?$/, "/");
  if (coordRel && !coordRel.startsWith("..") && fs.existsSync(path.resolve(projectRoot, coordDir))) {
    out.push(coordRel);
  }
  return out;
}

function mergeFoundationPaths(commonFoundations, declaredFoundations) {
  const out = new Map();
  for (const raw of [...commonFoundations, ...declaredFoundations]) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const analyzed = analyzePathPattern(raw);
    if (!out.has(analyzed.normalized)) out.set(analyzed.normalized, analyzed);
  }
  return Array.from(out.values());
}

function normalizePathList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim() !== "")
    .map(analyzePathPattern);
}

function compactStringList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item) => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim())));
}

function analyzePathPattern(raw) {
  const normalized = normalizePathPattern(raw);
  const broad = BROAD_PATTERNS.has(normalized) || normalized === "";
  const globIndex = searchGlobIndex(normalized);
  let root = normalized;
  let hasGlob = globIndex !== -1;
  let subtree = false;

  if (broad) {
    root = ".";
    hasGlob = true;
  } else if (normalized.endsWith("/**")) {
    root = normalized.slice(0, -3).replace(/\/+$/, "") || ".";
    subtree = true;
    hasGlob = true;
  } else if (normalized.endsWith("/*")) {
    root = normalized.slice(0, -2).replace(/\/+$/, "") || ".";
    subtree = true;
    hasGlob = true;
  } else if (hasGlob) {
    const beforeGlob = normalized.slice(0, globIndex);
    root = beforeGlob.includes("/")
      ? beforeGlob.slice(0, beforeGlob.lastIndexOf("/")).replace(/\/+$/, "") || "."
      : ".";
  }

  return {
    raw,
    normalized,
    broad,
    root,
    hasGlob,
    subtree,
  };
}

function patternsOverlap(left, right) {
  if (left.broad || right.broad) return true;
  if (left.normalized === right.normalized) return true;
  if (left.root === "." || right.root === ".") return true;
  if (left.root === right.root) return true;
  if (isPathPrefix(left.root, right.root) || isPathPrefix(right.root, left.root)) return true;
  if (left.subtree && isPathPrefix(left.root, right.normalized)) return true;
  if (right.subtree && isPathPrefix(right.root, left.normalized)) return true;
  return false;
}

function normalizePathPattern(raw) {
  return toPosixPath(String(raw).trim())
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "") || ".";
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function searchGlobIndex(value) {
  const indexes = ["*", "?", "["]
    .map((char) => value.indexOf(char))
    .filter((index) => index !== -1);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function isPathPrefix(parent, child) {
  return child.startsWith(`${parent}/`);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? result.error.message : ""),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatValidationReport(report, options = {}) {
  const lines = [];
  if (report.errors.length > 0) {
    lines.push("Context validation failed:");
    for (const error of report.errors) lines.push(`  ERROR ${error}`);
  }
  if (report.warnings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Context validation warnings:");
    for (const warning of report.warnings) lines.push(`  WARN  ${warning}`);
  }
  if (report.errors.length > 0) {
    const validateCommand = options.validateCommand || `node ${path.join(__dirname, "..", "validate-context.js")} --coord ${options.coordDir || "./coord"}`;
    lines.push("");
    lines.push(`Run this check directly: ${validateCommand}`);
    lines.push(`Edit ${options.contextPath || "coord/context.json"} and ${options.decisionsPath || "coord/DECISIONS.md"} before launching.`);
  }
  return lines.join("\n");
}

module.exports = {
  validateContext,
  formatValidationReport,
  analyzePathPattern,
  patternsOverlap,
};
