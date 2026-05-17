const fs = require("fs");
const path = require("path");
const { readJSON } = require("./locking");
const { renderWorkerPrompt, renderWorkerRestartPrompt } = require("./prompt-render");

/**
 * Render the prompt fed to a worker that is being restarted or resumed.
 *
 * Shared — used by the orchestrator loop's respawn path
 * (scripts/orchestrator-loop.js, via bumpRestartAndRespawn → respawnAgent) and
 * by the manual resume primitive (scripts/resume-agent.js). Both must produce
 * the identical prompt shape: the worker contract (task / ownership / caller
 * context) followed by the restart instruction block.
 *
 * @param {object}   args
 * @param {string}   args.name        - Agent name (key into context.tasks).
 * @param {string}   args.instruction - The restart/resume instruction text.
 * @param {string}   args.worktree    - Absolute worktree path for the worker.
 * @param {object}   args.paths       - { context, callerContextMd } file paths.
 * @param {function} args.log         - Logger for non-fatal render failures.
 * @returns {string} The fully rendered worker prompt.
 */
function renderRestartPrompt({ name, instruction, worktree, paths, log }) {
  const contractPrompt = renderRestartContractPrompt({ name, worktree, paths, log });
  return renderWorkerRestartPrompt(instruction, contractPrompt);

  // Single-use helper — only called from renderRestartPrompt above. Rebuilds
  // the worker's task/ownership contract from context.json so a restarted or
  // resumed worker is re-grounded in its scope, not just handed a bare
  // instruction. A missing task or a render failure degrades to "" (the caller
  // then emits the concision-only restart block) rather than aborting.
  function renderRestartContractPrompt({ name, worktree, paths, log }) {
    try {
      const context = readJSON(paths.context);
      const task = context.tasks?.[name];
      if (!task) return "";

      const templatePath = path.resolve(__dirname, "..", "..", "references", "worker-prompt-template.md");
      const template = fs.readFileSync(templatePath, "utf-8");
      const contractPrompt = renderWorkerPrompt(template, {
        ASSIGNED_TASK: task.description || "",
        PROJECT_DESCRIPTION: context.project || "",
        AGENT_NAME: name,
        WORKTREE_PATH: worktree || "",
        ALLOWED_PATHS_LIST: task.allowed_paths || [],
        FORBIDDEN_PATHS_LIST: task.forbidden_paths || [],
        READ_FIRST_LIST: task.read_first || task.relevant_files || [],
      });
      const callerContext = readTextIfExists(paths.callerContextMd).trim();
      if (!callerContext) return contractPrompt;
      return [
        contractPrompt,
        "",
        "## Caller Session Context from coord/CALLER_CONTEXT.md",
        callerContext,
        "",
      ].join("\n");
    } catch (err) {
      log(`Restart prompt contract render failed for ${name}: ${err.message}`);
      return "";
    }

    function readTextIfExists(filePath) {
      try {
        if (!fs.existsSync(filePath)) return "";
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return "";
      }
    }
  }
}

module.exports = { renderRestartPrompt };
