#!/usr/bin/env node

/**
 * Phase 5 helper: preview or apply integration of a completed worker branch.
 *
 * Default mode is human-gated preview (diff + merge conflict check only).
 * Pass --apply to merge into the current branch, remove the worktree, and
 * delete the agent branch.
 *
 * Usage:
 *   node scripts/integrate-agent.js --agent <name> [--coord ./coord]
 *   node scripts/integrate-agent.js --agent <name> --apply
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { runGit, gitStdout } = require("./lib/git-ops");
const { STATUS } = require("./lib/status");
const { updateJSON } = require("./lib/locking");
const { appendEvent } = require("./lib/events");
const { discoverDefaultBaseBranch } = require("./lib/git-base");

if (require.main === module) {
  integrateAgent();
}

function integrateAgent() {
  const config = parseArgs();
  const projectRoot = process.cwd();
  const coordDir = path.resolve(projectRoot, config.coordDir);
  const agentsPath = path.join(coordDir, "agents.json");

  if (!fs.existsSync(agentsPath)) {
    fail("agents.json not found. Bootstrap and launch workers before integrating.", 1);
  }

  const agents = readJson(agentsPath);
  const agent = agents[config.agent];
  if (!agent) {
    fail(`Agent '${config.agent}' not found in ${agentsPath}.`, 1);
  }

  const branch = (config.branch || config.agent).trim();
  const worktree = agent.worktree || resolveDefaultWorktree(projectRoot, config.agent, agent.cli);
  const baseRef = resolveBaseRef(agent, projectRoot, config.baseRef);
  const targetBranch = resolveTargetBranch(projectRoot, config.targetBranch);

  const blockers = collectBlockers(agent, config);
  if (blockers.length > 0 && !config.force) {
    fail(blockers.join("\n"), 1);
  }

  if (!refResolves(projectRoot, baseRef)) {
    fail(`base_ref '${baseRef}' does not resolve in ${projectRoot}.`, 1);
  }
  if (!refResolves(projectRoot, branch)) {
    fail(`Agent branch '${branch}' does not resolve. Is the worktree still present?`, 1);
  }
  if (worktree && !fs.existsSync(worktree)) {
    fail(`Worktree path does not exist: ${worktree}`, 1);
  }

  const diff = readGitLines(projectRoot, ["diff", `${baseRef}...${branch}`, "--stat"]);
  const diffNames = readGitLines(projectRoot, ["diff", `${baseRef}...${branch}`, "--name-only"]);
  const conflict = detectMergeConflicts(projectRoot, targetBranch, branch);

  const report = {
    ok: true,
    errors: [],
    agent: config.agent,
    branch,
    base_ref: baseRef,
    target_branch: targetBranch,
    worktree: worktree || null,
    status: agent.status || null,
    apply: config.apply,
    diff_stat: diff.trim(),
    changed_files: diffNames ? diffNames.split("\n").filter(Boolean) : [],
    merge_conflicts: conflict.hasConflicts,
    conflict_preview: conflict.preview,
    applied: false,
    warnings: blockers,
  };

  emitHumanHeader(report);
  if (diff.trim()) {
    process.stdout.write(`${diff.trim()}\n\n`);
  } else {
    process.stdout.write("(no diff vs base_ref)\n\n");
  }

  if (conflict.hasConflicts) {
    process.stdout.write("Merge conflict pre-check: CONFLICTS DETECTED\n");
    if (conflict.preview.trim()) {
      process.stdout.write(`${conflict.preview.trim()}\n\n`);
    }
    report.ok = false;
    report.errors.push("Merge conflict pre-check failed.");
    if (config.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    }
    process.exit(1);
  }

  process.stdout.write("Merge conflict pre-check: clean\n");

  if (!config.apply) {
    process.stdout.write(
      "\nPreview only. Re-run with --apply after you approve the diff to merge, remove the worktree, and delete the agent branch.\n",
    );
    if (config.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    }
    process.exit(0);
  }

  ensureCleanTarget(projectRoot, targetBranch);
  runGit(projectRoot, ["merge", branch, "--no-edit"]);
  if (worktree) {
    runGit(projectRoot, ["worktree", "remove", worktree, "--force"]);
  }
  runGit(projectRoot, ["branch", "-d", branch], { allowFailure: true });

  updateJSON(agentsPath, (current) => {
    const entry = current[config.agent];
    if (!entry) return;
    entry.integrated_at = new Date().toISOString();
    entry.integrated_into = targetBranch;
  });

  appendEvent(coordDir, "agent_integrated", {
    agent: config.agent,
    reason: "manual integrate",
    data: {
      branch,
      base_ref: baseRef,
      target_branch: targetBranch,
      worktree,
    },
  });

  report.applied = true;
  process.stdout.write(
    `\nApplied: merged '${branch}' into '${targetBranch}', removed worktree, deleted branch '${branch}'.\n`,
  );
  if (config.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}

function collectBlockers(agent, config) {
  if (config.force) return [];
  const warnings = [];
  const status = agent.status;
  if (status === STATUS.NEEDS_ATTENTION) {
    warnings.push(
      `Agent '${config.agent}' is '${STATUS.NEEDS_ATTENTION}'. Resume or abandon before integrating.`,
    );
  } else if (status === STATUS.RUNNING) {
    warnings.push(`Agent '${config.agent}' is still '${STATUS.RUNNING}'.`);
  } else if (status && status !== STATUS.COMPLETED && status !== "integrated") {
    warnings.push(`Agent '${config.agent}' status is '${status}' (expected '${STATUS.COMPLETED}').`);
  }
  return warnings;
}

function resolveBaseRef(agent, projectRoot, cliBaseRef) {
  if (cliBaseRef) return String(cliBaseRef).trim();
  if (agent.base_ref) return String(agent.base_ref).trim();
  const discovered = discoverDefaultBaseBranch(projectRoot);
  return (discovered.ref || "main").trim();
}

function resolveDefaultWorktree(projectRoot, agentName, cli) {
  const base = cli === "kilo" ? ".kilocode/worktrees" : ".agents/worktrees";
  return path.resolve(projectRoot, base, agentName);
}

function readGitRef(cwd, args) {
  return gitStdout(cwd, args).trim();
}

function readGitLines(cwd, args) {
  return gitStdout(cwd, args).trimEnd();
}

function detectMergeConflicts(projectRoot, targetBranch, branch) {
  const savedHead = readGitRef(projectRoot, ["rev-parse", "HEAD"]);
  const savedBranch = readGitRef(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let preview = "";

  try {
    if (savedBranch && savedBranch !== targetBranch) {
      runGit(projectRoot, ["checkout", targetBranch]);
    }

    const dryRun = runGit(projectRoot, ["merge", "--no-commit", "--no-ff", branch], { allowFailure: true });
    preview = `${dryRun.stdout || ""}\n${dryRun.stderr || ""}`.trim();
    const hasConflicts =
      /<<<<<<<|CONFLICT \(|fix conflicts before you commit/i.test(preview) &&
      !/Automatic merge went well/i.test(preview);

    runGit(projectRoot, ["merge", "--abort"], { allowFailure: true });
    runGit(projectRoot, ["reset", "--hard", "HEAD"], { allowFailure: true });
    return {
      hasConflicts,
      preview: preview.slice(0, 4000),
    };
  } finally {
    if (savedBranch && savedBranch !== "HEAD") {
      runGit(projectRoot, ["checkout", savedBranch], { allowFailure: true });
    } else if (savedHead) {
      runGit(projectRoot, ["checkout", savedHead], { allowFailure: true });
    }
  }
}

function resolveTargetBranch(projectRoot, explicit) {
  if (explicit) return String(explicit).trim();
  const current = readGitRef(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current && current !== "HEAD") return current;
  const discovered = discoverDefaultBaseBranch(projectRoot);
  return (discovered.ref || "main").trim();
}

function ensureCleanTarget(projectRoot, targetBranch) {
  const current = readGitRef(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== targetBranch) {
    runGit(projectRoot, ["checkout", targetBranch]);
  }
  const dirty = readGitLines(projectRoot, ["status", "--porcelain"])
    .split("\n")
    .filter((line) => line.trim() !== "" && !isIgnorableWorkingTreeLine(line))
    .join("\n");
  if (dirty.trim() !== "") {
    throw new Error(
      `Target branch '${targetBranch}' has uncommitted changes. Commit or stash before --apply.`,
    );
  }
}

function isIgnorableWorkingTreeLine(line) {
  return /^(?:\?\?|.[MTADRCU] )\s+(?:coord|\.agents|\.kilocode)(?:\/|$)/.test(line);
}

function refResolves(cwd, ref) {
  const result = runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
  return result.status === 0;
}

function emitHumanHeader(report) {
  process.stdout.write(
    `Integrate preview for agent '${report.agent}'\n` +
      `  branch: ${report.branch}\n` +
      `  base_ref: ${report.base_ref}\n` +
      `  target: ${report.target_branch}\n` +
      (report.worktree ? `  worktree: ${report.worktree}\n` : "") +
      (report.warnings.length ? `  warnings: ${report.warnings.join(" ")}\n` : "") +
      "\n",
  );
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    fail(`Failed to read ${filePath}: ${err.message}`, 1);
  }
}

function fail(message, code) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function parseArgs() {
  const cfg = {
    agent: "",
    coordDir: "./coord",
    apply: false,
    force: false,
    json: false,
    baseRef: undefined,
    branch: undefined,
    targetBranch: undefined,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--agent":
        cfg.agent = argv[++i];
        break;
      case "--coord":
        cfg.coordDir = argv[++i];
        break;
      case "--apply":
        cfg.apply = true;
        break;
      case "--force":
        cfg.force = true;
        break;
      case "--json":
        cfg.json = true;
        break;
      case "--base-ref":
        cfg.baseRef = argv[++i];
        break;
      case "--branch":
        cfg.branch = argv[++i];
        break;
      case "--target-branch":
        cfg.targetBranch = argv[++i];
        break;
      case "--help":
      case "-h":
        process.stdout.write(usage() + "\n");
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${argv[i]}`, 1);
    }
  }
  if (!cfg.agent) {
    fail("--agent is required.\n" + usage(), 1);
  }
  return cfg;
}

function usage() {
  return (
    "Usage: node scripts/integrate-agent.js --agent <name> [--coord <dir>] [--apply]\n" +
    "       [--base-ref <ref>] [--branch <branch>] [--target-branch <branch>] [--force] [--json]\n" +
    "\n" +
    "Default: preview git diff and merge conflict check (human-gated).\n" +
    "  --apply  merge into the target branch, remove worktree, delete agent branch."
  );
}

module.exports = {
  integrateAgent,
  collectBlockers,
  detectMergeConflicts,
  resolveBaseRef,
};
