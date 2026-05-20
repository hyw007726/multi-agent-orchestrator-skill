const { spawnSync } = require("child_process");

function stageAllChanges(worktree) {
  const result = spawnSync("git", ["add", "-A"], { cwd: worktree, stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git add -A exited with status ${result.status}`);
}

function stageCompletionChanges(worktree, changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  if (files.length === 0) return;
  const result = spawnSync("git", ["add", "-A", "--", ...files], { cwd: worktree, stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git add -A -- <owned files> exited with status ${result.status}`);
}

function gitStdout(cwd, args) {
  return runGit(cwd, args).stdout;
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const normalized = {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
  if (normalized.error) {
    if (options.allowFailure) return normalized;
    throw normalized.error;
  }
  if (normalized.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} exited with status ${normalized.status}: ${gitErrorDetails(normalized)}`);
  }
  return normalized;
}

function gitErrorDetails(result) {
  return (result.stderr || result.stdout || (result.error && result.error.message) || `exit ${result.status}`).trim();
}

function commitWorktree(worktree, message) {
  const result = spawnSync("git", ["commit", "-m", String(message)], {
    cwd: worktree,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.error) throw result.error;
  return {
    committed: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

module.exports = {
  stageAllChanges,
  stageCompletionChanges,
  gitStdout,
  runGit,
  gitErrorDetails,
  commitWorktree,
};
