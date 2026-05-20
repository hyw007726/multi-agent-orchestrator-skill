const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readJSON } = require("./locking");
const { discoverDefaultBaseBranch } = require("./git-base");

function checkCompletionOwnership(agentName, agent, paths, log) {
  const worktree = agent.worktree;
  if (!worktree || !fs.existsSync(worktree)) {
    return ownershipResult({
      ok: true,
      changedFiles: [],
      forbiddenViolations: [],
      outsideAllowed: [],
      allowedPaths: [],
      forbiddenPaths: [],
    });
  }

  const task = readTaskContext(paths.context, agentName) || {};
  const allowedPaths = pathList(task.allowed_paths || agent.allowed_paths);
  const forbiddenPaths = pathList(task.forbidden_paths || agent.forbidden_paths);
  const changed = collectOwnershipChangedFiles(worktree, agent.base_ref, log);
  const changedFiles = changed.files.filter((file) => !isRuntimeCoordSymlink(file, worktree));
  const forbiddenViolations = changedFiles.filter((file) => matchesAnyPathPattern(file, forbiddenPaths));
  const outsideAllowed = changedFiles.filter((file) => !matchesAnyPathPattern(file, allowedPaths));
  const errors = changed.errors.slice();
  if (allowedPaths.length === 0 && changedFiles.length > 0) {
    errors.push("allowed_paths is missing or empty for this agent.");
  }

  return ownershipResult({
    ok: errors.length === 0 && forbiddenViolations.length === 0 && outsideAllowed.length === 0,
    changedFiles,
    forbiddenViolations,
    outsideAllowed,
    allowedPaths,
    forbiddenPaths,
    errors,
  });
}

function ownershipResult(result) {
  const issues = [];
  if (result.errors?.length > 0) issues.push(`${result.errors.length} ownership check error(s)`);
  if (result.forbiddenViolations.length > 0) issues.push(`${result.forbiddenViolations.length} forbidden-path change(s)`);
  if (result.outsideAllowed.length > 0) issues.push(`${result.outsideAllowed.length} change(s) outside allowed_paths`);
  return {
    errors: [],
    ...result,
    summary: issues.length > 0 ? issues.join("; ") : "changed files are within ownership.",
  };
}

function formatOwnershipViolation(result) {
  return [
    `Allowed paths: ${formatList(result.allowedPaths)}`,
    `Forbidden paths: ${formatList(result.forbiddenPaths)}`,
    `Changed files checked: ${formatOwnershipFileList(result.changedFiles)}`,
    `Forbidden-path violations: ${formatOwnershipFileList(result.forbiddenViolations)}`,
    `Outside allowed_paths: ${formatOwnershipFileList(result.outsideAllowed)}`,
    result.errors.length > 0 ? `Ownership check errors: ${result.errors.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

function collectOwnershipChangedFiles(worktree, baseRef, log) {
  const files = new Set();
  const errors = [];
  const base = resolveOwnershipBaseRef(worktree, baseRef);
  if (base.error) {
    errors.push(base.error);
  } else if (base.ref) {
    addGitLines(files, worktree, ["diff", "--name-only", `${base.ref}...HEAD`, "--"], errors, `committed diff against ${base.ref}`);
  }

  addGitLines(files, worktree, ["diff", "--name-only", "--"], errors, "unstaged diff");
  addGitLines(files, worktree, ["diff", "--staged", "--name-only", "--"], errors, "staged diff");
  addGitLines(files, worktree, ["ls-files", "--others", "--exclude-standard"], errors, "untracked files");

  if (errors.length > 0) {
    log(`Ownership check could not inspect all changed files: ${errors.join("; ")}`);
  }

  return {
    files: Array.from(files).map(normalizeRepoPath).filter(Boolean).sort(),
    errors,
  };
}

function resolveOwnershipBaseRef(worktree, baseRef) {
  const requested = typeof baseRef === "string" && baseRef.trim() ? baseRef.trim() : "";
  const discovered = requested ? null : discoverDefaultBaseBranch(worktree);
  const candidates = requested ? [requested] : (discovered.ref ? [discovered.ref] : []);
  for (const candidate of candidates) {
    const result = spawnSync("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
      cwd: worktree,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) return { ref: candidate };
  }
  if (requested) {
    return { ref: "", error: `base_ref "${requested}" does not resolve to a commit.` };
  }
  return { ref: "", error: "No default base ref resolves to a commit (tried origin/HEAD, init.defaultBranch, then current branch)." };
}

function addGitLines(files, cwd, args, errors, label) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    errors.push(`${label}: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    errors.push(`${label}: ${details || `git exited ${result.status}`}`);
    return;
  }
  for (const line of (result.stdout || "").split("\n")) {
    const normalized = normalizeRepoPath(line);
    if (normalized) files.add(normalized);
  }
}

function pathList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function matchesAnyPathPattern(file, patterns) {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => pathPatternMatches(file, pattern));
}

function pathPatternMatches(file, rawPattern) {
  const raw = String(rawPattern || "").trim();
  if (!raw) return false;
  const filePath = normalizeRepoPath(file);
  const pattern = normalizeRepoPath(raw);
  if (!pattern) return false;
  if (pattern === "." || pattern === "*" || pattern === "**" || pattern === "**/*") return true;

  if (pattern.endsWith("/**")) {
    const root = pattern.slice(0, -3).replace(/\/+$/, "");
    return filePath === root || filePath.startsWith(`${root}/`);
  }

  if (!hasGlob(pattern)) {
    return filePath === pattern || filePath.startsWith(`${pattern}/`);
  }

  return globPatternToRegExp(pattern).test(filePath);
}

function globPatternToRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

function hasGlob(pattern) {
  return /[*?\[]/.test(pattern);
}

function normalizeRepoPath(value) {
  return toPosixPath(String(value || "").trim())
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function isRuntimeCoordSymlink(file, worktree) {
  const normalized = normalizeRepoPath(file);
  if (normalized !== "coord" && !normalized.startsWith("coord/")) return false;
  try {
    return fs.lstatSync(path.join(worktree, "coord")).isSymbolicLink();
  } catch {
    return false;
  }
}

function formatOwnershipFileList(files) {
  if (!Array.isArray(files) || files.length === 0) return "(none)";
  const shown = files.slice(0, 20);
  const suffix = files.length > shown.length ? `, ... (${files.length - shown.length} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function formatList(value) {
  if (Array.isArray(value) && value.length > 0) return value.join(", ");
  return "(unspecified)";
}

function readTaskContext(contextPath, agentName) {
  try {
    const context = readJSON(contextPath);
    return context.tasks?.[agentName] || null;
  } catch {
    return null;
  }
}

module.exports = {
  checkCompletionOwnership,
  ownershipResult,
  formatOwnershipViolation,
  collectOwnershipChangedFiles,
  resolveOwnershipBaseRef,
  addGitLines,
  pathList,
  matchesAnyPathPattern,
  pathPatternMatches,
  globPatternToRegExp,
  hasGlob,
  normalizeRepoPath,
  isRuntimeCoordSymlink,
  formatOwnershipFileList,
  escapeRegExp,
  toPosixPath,
};
