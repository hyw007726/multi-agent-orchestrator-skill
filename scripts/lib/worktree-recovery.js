const fs = require("fs");
const path = require("path");
const { stageAllChanges, commitWorktree, runGit, gitStdout, gitErrorDetails } = require("./git-ops");

// Captures uncommitted+untracked state in a recovery tag, then resets the worktree.
// Returns { tag: string | null, error: string | null }.
// If error is set the worktree was NOT touched — the caller must abort the restart.
// `runId` (optional) is embedded in the tag name so tags from prior runs are
// trivially distinguishable from this run's tags (matches the run_id stamped on
// the recovery_tag_created event).
function captureRecoveryAndReset(worktree, agent, log, runId) {
  try {
    const nestedGitState = inspectNestedGitState(worktree);
    if (nestedGitState.unknownNestedGitPaths.length > 0) {
      return {
        tag: null,
        error: `nested git state detected outside declared submodules: ${nestedGitState.unknownNestedGitPaths.join(", ")}`,
      };
    }

    const headBefore = gitStdout(worktree, ["rev-parse", "HEAD"]).trim();
    let createdRecovery = false;
    try {
      stageAllChanges(worktree);
      const commit = commitWorktree(worktree, "RECOVERY: pre-hard-restart");
      createdRecovery = commit.committed;
    } catch (err) {
      log(`Recovery staging failed: ${err.message}`);
    }

    let tag = null;
    if (createdRecovery) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      // Random suffix keeps the tag collision-safe even if two restarts land in
      // the same millisecond (the ISO timestamp alone is not unique enough).
      const suffix = Math.random().toString(36).slice(2, 8);
      const runSegment = runId ? `${runId}/` : "";
      tag = `recovery/${agent}/${runSegment}${ts}-${suffix}`;
      const tagResult = runGit(worktree, ["tag", tag], { allowFailure: true });
      if (tagResult.status !== 0) {
        const details = gitErrorDetails(tagResult);
        log(`Failed to create recovery tag: ${details}`);
        // The RECOVERY commit is on HEAD but unlabeled. Discard it before bailing
        // so it can't later be merged into main as an unlabeled pollutant.
        try {
          runGit(worktree, ["reset", "--hard", "HEAD~1"]);
        } catch (resetErr) {
          log(`Failed to roll back orphaned RECOVERY commit: ${resetErr.message}`);
        }
        return { tag: null, error: `recovery commit created but tag failed: ${details}` };
      }
    }

    runGit(worktree, ["reset", "--hard", headBefore]);
    runGit(worktree, gitCleanArgsForNestedGitState(nestedGitState));
    return { tag, error: null };
  } catch (err) {
    log(`Hard reset failed: ${err.message}`);
    return { tag: null, error: `hard reset failed: ${err.message}` };
  }
}

function inspectNestedGitState(worktree) {
  const submodulePaths = collectDeclaredSubmodulePaths(worktree);
  const nestedGitPaths = collectNestedGitPaths(worktree);
  const unknownNestedGitPaths = nestedGitPaths.filter((nestedPath) =>
    !submodulePaths.some((submodulePath) => pathWithinRepoPath(nestedPath, submodulePath))
  );
  return { submodulePaths, nestedGitPaths, unknownNestedGitPaths };
}

function collectDeclaredSubmodulePaths(worktree) {
  const paths = new Set();
  for (const raw of [
    ...readSubmodulePathsFromGitmodules(worktree),
    ...readSubmodulePathsFromConfig(worktree),
  ]) {
    const normalized = normalizeRepoRelativePath(raw);
    if (normalized) paths.add(normalized);
  }
  return [...paths].sort();
}

function readSubmodulePathsFromGitmodules(worktree) {
  if (!fs.existsSync(path.join(worktree, ".gitmodules"))) return [];
  const result = runGit(worktree, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], { allowFailure: true });
  if (result.status !== 0) return [];
  return parseGitConfigPathValues(result.stdout);
}

function readSubmodulePathsFromConfig(worktree) {
  const result = runGit(worktree, ["config", "--local", "--get-regexp", "^submodule\\..*\\.path$"], { allowFailure: true });
  if (result.status !== 0) return [];
  return parseGitConfigPathValues(result.stdout);
}

function parseGitConfigPathValues(stdout) {
  const paths = [];
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^[^\s]+\s+(.+)$/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

function collectNestedGitPaths(worktree) {
  const nested = [];
  walk(worktree, "");
  return nested.sort();

  function walk(absDir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") {
        if (relDir !== "") nested.push(relDir);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (relDir === "" && entry.name === ".git") continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (childRel === ".git") continue;
      walk(path.join(absDir, entry.name), childRel);
    }
  }
}

function gitCleanArgsForNestedGitState(nestedGitState) {
  const args = ["clean", "-fd"];
  for (const submodulePath of nestedGitState.submodulePaths) {
    args.push(`--exclude=${submodulePath}`);
    args.push(`--exclude=${submodulePath}/**`);
  }
  return args;
}

function normalizeRepoRelativePath(rawPath) {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  if (!trimmed || path.isAbsolute(trimmed)) return "";
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return "";
  return normalized.replace(/\/+$/, "");
}

function pathWithinRepoPath(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

module.exports = {
  captureRecoveryAndReset,
  inspectNestedGitState,
  collectDeclaredSubmodulePaths,
  readSubmodulePathsFromGitmodules,
  readSubmodulePathsFromConfig,
  parseGitConfigPathValues,
  collectNestedGitPaths,
  gitCleanArgsForNestedGitState,
  normalizeRepoRelativePath,
  pathWithinRepoPath,
};
