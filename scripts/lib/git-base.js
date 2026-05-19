"use strict";

const { spawnSync } = require("child_process");

function discoverDefaultBaseBranch(cwd) {
  const originHead = gitStdout(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead && refResolves(cwd, originHead)) {
    return { ref: originHead, source: "origin/HEAD" };
  }

  const configuredDefault = gitStdout(cwd, ["config", "--get", "init.defaultBranch"]);
  if (configuredDefault && refResolves(cwd, configuredDefault)) {
    return { ref: configuredDefault, source: "init.defaultBranch" };
  }

  const currentBranch = gitStdout(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch && currentBranch !== "HEAD" && refResolves(cwd, currentBranch)) {
    return { ref: currentBranch, source: "current branch" };
  }

  return { ref: "", source: "unresolved" };
}

function refResolves(cwd, ref) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function gitStdout(cwd, args) {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return "";
    return (result.stdout || "").trim();
  } catch {
    return "";
  }
}

module.exports = { discoverDefaultBaseBranch };
