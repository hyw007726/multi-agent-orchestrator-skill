#!/usr/bin/env node

/**
 * Resume a parked (needs_attention) worker after a human has fixed the
 * underlying cause.
 *
 * Parallels scripts/spawn-agent.js: it owns no loop state, can run whether or
 * not the orchestrator loop is up, and delegates the actual process launch to
 * spawn-agent.js (the single worker-spawn entry point). It only adds the
 * needs_attention -> running transition and the attention_* cleanup, then hands
 * off. See docs/resolving-needs-attention.md for the full operator workflow.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfig } = require("./lib/config");
const { updateJSON } = require("./lib/locking");
const { appendEvent } = require("./lib/events");
const { STATUS, transitionAgentStatus } = require("./lib/status");
const { renderRestartPrompt } = require("./lib/restart-prompt");

resumeAgent();

function resumeAgent() {
  const config = parseArgs();
  const parsedConfig = loadConfig();
  const coordDir = config.coordDir;
  const paths = {
    agents: path.resolve(coordDir, "agents.json"),
    context: path.resolve(coordDir, "context.json"),
    callerContextMd: path.resolve(coordDir, "CALLER_CONTEXT.md"),
  };

  if (!fs.existsSync(paths.agents)) {
    console.error(`Error: ${paths.agents} does not exist. Nothing to resume.`);
    process.exit(1);
  }

  const instruction = resolveInstruction(config);
  const log = (msg) => console.log(msg);

  // Atomic transition: a concurrent loop tick must never observe a
  // half-cleared parked agent (status flipped but attention_* still set, or
  // the reverse). Everything below lands in one updateJSON callback; the
  // structured event and the relaunch happen after the lock releases.
  const outcomeRef = { value: { kind: "missing" } };
  updateJSON(paths.agents, (agents) => {
    const agent = agents[config.agent];
    if (!agent) {
      outcomeRef.value = { kind: "missing" };
      return;
    }
    if (agent.status !== STATUS.NEEDS_ATTENTION) {
      outcomeRef.value = { kind: "wrong_status", status: agent.status };
      return;
    }

    const priorAttentionReason = agent.attention_reason;
    const priorAttentionAt = agent.attention_at;
    const priorNextSteps = agent.next_steps;

    transitionAgentStatus(agent, config.agent, STATUS.RUNNING, "manual resume", log);
    delete agent.attention_reason;
    delete agent.attention_at;
    delete agent.next_steps;
    if (!config.preserveRestartCount) agent.restart_count = 0;
    // Fresh liveness clock so the loop's idle / progress-timeout checks don't
    // re-trip on this agent before the relaunched worker writes its first log
    // line. spawn-agent.js bumps these again on re-register; setting them here
    // closes the window where a running loop sees the old, stale timestamps.
    const now = new Date().toISOString();
    agent.current_started_at = now;
    agent.last_heartbeat = now;
    // Manual intervention is itself a milestone: it means a human looked at
    // the agent and decided to keep going, so the next stall should start
    // counting from `first_timeout` again rather than chaining into the prior
    // history.
    agent.progress_timeout_reset_at = now;
    agent.progress_timeout_reset_kind = "resume";

    outcomeRef.value = {
      kind: "resume",
      task: agent.task,
      cli: agent.cli || parsedConfig.default_cli,
      kiloMode: agent.kilo_mode,
      worktree: agent.worktree,
      validateCmd: agent.validate_cmd,
      timeoutMins: agent.timeout_mins,
      progressTimeoutMins: agent.progress_timeout_mins,
      baseRef: agent.base_ref,
      resetRestartCount: !config.preserveRestartCount,
      priorAttentionReason,
      priorAttentionAt,
      priorNextSteps,
    };
  });

  const outcome = outcomeRef.value;
  if (outcome.kind === "missing") {
    console.error(`Error: agent '${config.agent}' not found in ${paths.agents}.`);
    process.exit(1);
  }
  if (outcome.kind === "wrong_status") {
    console.error(
      `Error: agent '${config.agent}' is '${outcome.status}', not '${STATUS.NEEDS_ATTENTION}'. ` +
      `Resume only operates on a parked agent; refusing to touch a '${outcome.status}' one. ` +
      `(Rescuing a truly errored agent is a separate, deliberate action and out of scope here.)`
    );
    process.exit(1);
  }

  const resumeInstruction = instruction ?? outcome.task ?? "Resume the assigned task.";

  const promptsDir = path.join(path.dirname(paths.agents), "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  const promptFile = path.join(promptsDir, `resume-${config.agent}-${Date.now()}.txt`);
  fs.writeFileSync(
    promptFile,
    renderRestartPrompt({ name: config.agent, instruction: resumeInstruction, worktree: outcome.worktree, paths, log }),
    "utf-8"
  );

  const spawnArgs = [
    path.join(__dirname, "spawn-agent.js"),
    "--agent", config.agent,
    "--mode", outcome.kiloMode || "auto",
    "--prompt-file", promptFile,
    "--coord", path.dirname(paths.agents),
    "--cli", outcome.cli,
  ];
  appendSpawnArg(spawnArgs, "--validate", outcome.validateCmd, serializeValidateCmd);
  appendSpawnArg(spawnArgs, "--timeout", outcome.timeoutMins, String);
  appendSpawnArg(spawnArgs, "--progress-timeout", outcome.progressTimeoutMins, String);
  appendSpawnArg(spawnArgs, "--base-ref", outcome.baseRef, String);

  const result = spawnSync("node", spawnArgs, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `spawn-agent.js exited with status ${result.status}`;
    // Re-park the agent: the running flip never produced a live worker, so
    // leaving status=running with cleared attention_* hides a broken agent.
    // Restore the prior attention_reason annotated with the spawn failure so
    // the operator sees both the original park cause and why the relaunch
    // failed. Best-effort: if this second updateJSON throws, surface that on
    // top of the spawn failure rather than swallowing the original error.
    try {
      updateJSON(paths.agents, (agents) => {
        const agent = agents[config.agent];
        if (!agent) return;
        const annotated = `manual resume relaunch failed: ${why}` +
          (outcome.priorAttentionReason ? ` (was: ${outcome.priorAttentionReason})` : "");
        transitionAgentStatus(agent, config.agent, STATUS.NEEDS_ATTENTION, "resume relaunch failed", log);
        agent.attention_reason = annotated;
        agent.attention_at = new Date().toISOString();
        if (outcome.priorNextSteps !== undefined) agent.next_steps = outcome.priorNextSteps;
      });
      appendEvent(coordDir, "agent_resume_failed", {
        agent: config.agent,
        reason: why,
        data: {
          prior_attention_reason: outcome.priorAttentionReason,
          prior_attention_at: outcome.priorAttentionAt,
        },
      });
    } catch (restoreErr) {
      console.error(`Error: failed to re-park '${config.agent}' after spawn failure: ${restoreErr.message}`);
    }
    console.error(`Error: failed to relaunch '${config.agent}': ${why}`);
    process.exit(1);
  }

  appendEvent(coordDir, "agent_resumed", {
    agent: config.agent,
    reason: "manual resume",
    data: {
      reset_restart_count: outcome.resetRestartCount,
      prior_attention_reason: outcome.priorAttentionReason,
      prior_attention_at: outcome.priorAttentionAt,
    },
  });

  console.log(
    `Resumed agent '${config.agent}' ` +
    `(restart_count ${outcome.resetRestartCount ? "reset to 0" : "preserved"}).`
  );

  // Single-use helper — only called from resumeAgent above.
  function resolveInstruction(cfg) {
    if (cfg.instructionFile) {
      const text = fs.readFileSync(cfg.instructionFile, "utf-8");
      if (text.trim() !== "") return text;
    }
    if (typeof cfg.instruction === "string" && cfg.instruction.trim() !== "") {
      return cfg.instruction;
    }
    return undefined;
  }

  // Single-use helper — only called from resumeAgent above. Mirrors
  // respawnAgent's argv assembly in scripts/orchestrator-loop.js so a resumed
  // worker is launched with the same validate / timeout / base-ref carried on
  // its agent record.
  function appendSpawnArg(args, flag, value, serialize) {
    if (value === undefined || value === null || value === "") return;
    args.push(flag, serialize(value));
  }

  function serializeValidateCmd(value) {
    return Array.isArray(value) ? JSON.stringify(value) : String(value);
  }

  // Single-use helper — only called from resumeAgent above.
  function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
      agent: "",
      coordDir: "./coord",
      instruction: undefined,
      instructionFile: undefined,
      preserveRestartCount: false,
    };
    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--agent":                  cfg.agent                = args[++i]; break;
        case "--coord":                  cfg.coordDir             = args[++i]; break;
        case "--instruction":            cfg.instruction          = args[++i]; break;
        case "--instruction-file":       cfg.instructionFile      = args[++i]; break;
        case "--preserve-restart-count": cfg.preserveRestartCount = true;      break;
      }
    }
    if (!cfg.agent) {
      console.error("Error: --agent is required.");
      console.error(
        "Usage: node scripts/resume-agent.js --agent <name> [--coord <dir>] " +
        "[--instruction <text> | --instruction-file <path>] [--preserve-restart-count]"
      );
      process.exit(1);
    }
    return cfg;
  }
}
