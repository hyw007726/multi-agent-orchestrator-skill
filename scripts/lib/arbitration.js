const fs = require("fs");
const path = require("path");
const os = require("os");
const { gitStdout } = require("./git-ops");
const { cliTemplateMode, spawnCliTemplate } = require("./cli-template");
const { extractJsonObject } = require("./provider-output");

const RECENT_DECISION_LIMIT = 30;

function collectWorktreeStates(pending, agents) {
  const states = {};
  for (const req of pending) {
    if (states[req.agent] || !agents[req.agent]) continue;
    const worktree = agents[req.agent].worktree;
    if (!fs.existsSync(worktree)) continue;
    try {
      const status = gitStdout(worktree, ["status", "-s"]);
      const baseBranch = agents[req.agent].base_ref || "main";

      const diffStatUnstaged = gitStdout(worktree, ["diff", "--stat"]);
      const diffStatStaged = gitStdout(worktree, ["diff", "--staged", "--stat"]);
      const diffStatBranch = gitStdout(worktree, ["diff", `${baseBranch}...HEAD`, "--stat"]);

      let targetedDiffs = "";
      try {
        const filesChanged = gitStdout(worktree, ["diff", `${baseBranch}...HEAD`, "--name-only"]).split("\n").filter(Boolean);
        for (const file of filesChanged) {
          if (req.content.includes(file) || req.content.includes(path.basename(file))) {
            const fileDiff = gitStdout(worktree, ["diff", `${baseBranch}...HEAD`, "--", file]);
            targetedDiffs += `\nFull diff for ${file}:\n${fileDiff.slice(0, 3000)}`;
          }
        }
      } catch {}

      states[req.agent] = `STATUS:\n${status}\n\nCHANGES (UNSTAGED):\n${diffStatUnstaged}\nCHANGES (STAGED):\n${diffStatStaged}\nCHANGES (COMMITS against ${baseBranch}):\n${diffStatBranch}${targetedDiffs ? "\n\nTARGETED DIFFS:\n" + targetedDiffs : ""}`;
    } catch (err) {
      states[req.agent] = `Failed to read worktree state: ${err.message}`;
    }
  }
  return states;
}

// ─── Orchestrator CLI invocation ─────────────────────────────────────────────

// Cap-aware wrapper around buildOrchestratorPrompt. Smaller-context arbitration
// CLIs silently degrade once their input drifts past ~30 KB, so when several
// stalled agents each contribute a 50-line log tail + diff snapshot we compact
// per-request content (and worktree state blobs) before re-rendering. The first
// render is still attempted at full fidelity; only blobs are truncated on
// overflow, never structural fields like request_id / type.
const ARBITRATION_PROMPT_CAP_BYTES = 32 * 1024;
const ARBITRATION_PER_REQUEST_CAP_BYTES = 4 * 1024;
const ARBITRATION_PER_STATE_CAP_BYTES = 2 * 1024;

function buildBoundedArbitrationPrompt({ pending, context, durableDecisions, recentDecisions, worktreeStates, callerContext, log }) {
  const fullPrompt = buildOrchestratorPrompt(pending, context, durableDecisions, recentDecisions, worktreeStates, callerContext);
  if (Buffer.byteLength(fullPrompt, "utf-8") <= ARBITRATION_PROMPT_CAP_BYTES) return fullPrompt;

  const compactedPending = pending.map((req) => {
    if (!req || typeof req.content !== "string") return req;
    return { ...req, content: truncateMiddle(req.content, ARBITRATION_PER_REQUEST_CAP_BYTES) };
  });
  const compactedStates = {};
  for (const [agent, state] of Object.entries(worktreeStates || {})) {
    compactedStates[agent] = typeof state === "string"
      ? truncateMiddle(state, ARBITRATION_PER_STATE_CAP_BYTES)
      : state;
  }

  const compactPrompt = buildOrchestratorPrompt(compactedPending, context, durableDecisions, recentDecisions, compactedStates, callerContext);
  const originalKb = (Buffer.byteLength(fullPrompt, "utf-8") / 1024).toFixed(1);
  const cappedKb = (Buffer.byteLength(compactPrompt, "utf-8") / 1024).toFixed(1);
  log?.(`Arbitration prompt exceeded ${(ARBITRATION_PROMPT_CAP_BYTES / 1024).toFixed(0)} KB (was ${originalKb} KB) — compacted per-request and worktree-state blobs to ${cappedKb} KB.`);
  return compactPrompt;
}

// Keeps the head and tail of a long blob and inserts a marker between them.
// Useful for log tails + diff snapshots where both early structure (headers)
// and recent content (most recent log lines / diff endings) carry signal.
function truncateMiddle(text, maxBytes) {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  const marker = `\n[...truncated ${buf.length - maxBytes} bytes...]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  if (maxBytes <= markerBytes) return marker.trim();
  const keep = maxBytes - markerBytes;
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  return `${buf.slice(0, head).toString("utf-8")}${marker}${buf.slice(buf.length - tail).toString("utf-8")}`;
}

// Builds the arbitration prompt sent to the orchestrator CLI for each pending-request cycle.
function buildOrchestratorPrompt(requests, context, durableDecisions, decisions, worktreeStates, callerContext = "") {
  return `You are the system orchestrator for a multi-agent project.

Worker agents are running as headless CLI sessions, each in an isolated git worktree.
They submit requests by atomically writing JSON files into coord/requests/.
The loop consolidates those files into coord/requests.jsonl for arbitration.

## Responsibilities
- Maintain consistency across all agent sessions
- Resolve requests without contradicting existing decisions
- Prevent conflicts between agents working in parallel worktrees
- Prefer minimal disruption to running sessions
- Reject unclear requests — ask for clarification rather than guessing
- Treat \`progress_timeout\` requests as loop-generated diagnostics for agents that are alive but making no git-visible progress; choose whether to \`soft_restart\`, \`hard_restart\`, wait, or reject for manual inspection based on the request context.
- For \`progress_timeout\` requests, consider \`escalation_level\`, \`suggested_action\`, \`progress_timeout_count\`, \`restart_count\`, \`restarts_remaining\`, and any progress heartbeat before choosing an action.
- Every request you process MUST be explicitly included in either the \`approved\` or \`rejected\` array. Even if you issue an action like \`end_agent\`, you MUST STILL approve the request that triggered it so it is marked as resolved.

## Response Format
Return ONLY valid JSON matching this exact structure (no markdown, no explanation):
{
  "approved": [
    { "request_id": "...", "decision": "clear statement of what was decided", "reason": "why this decision was made" }
  ],
  "rejected": [
    { "request_id": "...", "reason": "why this was rejected" }
  ],
  "actions": [
    { "type": "end_agent | soft_restart | hard_restart", "agent": "agent-name", "instruction": "optional — new instructions for the session" }
  ]
}

## Dynamic Inputs

## Compact Project Context
${JSON.stringify(context, null, 2)}

## Durable Project Decisions from coord/DECISIONS.md (DO NOT contradict these)
${durableDecisions.trim() || "(none recorded)"}

## Caller Session Context from coord/CALLER_CONTEXT.md
${callerContext.trim() || "(none recorded)"}

## Recent Runtime Decisions (DO NOT contradict these)
${JSON.stringify(decisions, null, 2)}

## Agent Worktree States (Code Context)
Here is the current git status and diff for the agents that submitted requests. Use this code context to understand their progress and evaluate their requests:
${JSON.stringify(worktreeStates, null, 2)}

## New Requests from Agents
${JSON.stringify(requests, null, 2)}

## Your Responsibilities
Apply the responsibilities and response format above to these new requests.
`;
}

// Calls the orchestrator CLI for arbitration. Honors `orchestrator_cli` + `cli_templates`
// in orchestrator config so monitoring runs through a configurable (often cheap) model.
async function callOrchestratorCli(prompt, parsedConfig, maxRetries, log, abortFlagPath) {
  const cli = parsedConfig.orchestrator_cli;
  const template = parsedConfig.cli_templates[cli];
  const timeoutMs = parsedConfig.orchestrator_cli_timeout_ms;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const mode = template ? cliTemplateMode(template) : "missing-template";
    log(`Calling orchestrator CLI '${cli}' via ${mode} mode (attempt ${attempt}/${maxRetries}, timeout ${timeoutMs}ms)...`);
    const { stdout, error } = await invokeOrchestratorCli(cli, template, prompt, timeoutMs);
    if (abortFlagPath && fs.existsSync(abortFlagPath)) {
      log(`Orchestrator CLI call aborted via flag.`);
      return null;
    }
    if (error) {
      log(`Orchestrator CLI failed: ${error}`);
      if (attempt === maxRetries) return null;
      continue;
    }
    const parsed = extractJsonObject(stdout);
    if (!parsed) {
      log(`No JSON object in CLI output (attempt ${attempt}).`);
      if (attempt === maxRetries) return null;
      continue;
    }
    log(`Orchestrator CLI call succeeded.`);
    return parsed;
  }
  return null;

  // Single-use helper — only called from the retry loop above.
  function invokeOrchestratorCli(cli, template, prompt, timeoutMs) {
    if (!template) {
      return Promise.resolve({ stdout: "", error: `No cli_templates.${cli} configured for orchestrator_cli.` });
    }

    const promptFile = path.join(os.tmpdir(), `orch-prompt-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt, "utf-8");

    return new Promise((resolve) => {
      let child;
      let settled = false;
      let stdout = "";
      let stderr = "";
      const maxBuffer = 1024 * 1024 * 10;

      let abortWatcher = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { abortWatcher?.close(); } catch {}
        try { fs.unlinkSync(promptFile); } catch {}
        resolve(value);
      };

      // Watch for abort.flag while the CLI runs so Ctrl+C (which writes the
      // flag) cancels the in-flight subprocess promptly instead of feeling
      // unresponsive for up to timeoutMs. The top-of-loop handler then runs
      // the real abort path on the next cycle.
      if (abortFlagPath) {
        const watchAbort = () => {
          if (settled || !fs.existsSync(abortFlagPath)) return;
          const pid = child?.pid;
          if (pid) {
            log(`Abort flag detected; cancelling in-flight orchestrator CLI (PID ${pid}).`);
            killTimedOutChild(pid);
          }
          try { child?.stdout?.destroy(); } catch {}
          try { child?.stderr?.destroy(); } catch {}
          finish({ stdout, error: "Aborted by abort.flag" });
        };
        try {
          abortWatcher = fs.watch(path.dirname(abortFlagPath), (_event, filename) => {
            if (!filename || filename === path.basename(abortFlagPath)) watchAbort();
          });
        } catch {}
        watchAbort(); // Catch a flag written before the watch was armed.
      }

      const timeout = setTimeout(() => {
        const pid = child?.pid;
        if (pid) {
          log(`Orchestrator CLI '${cli}' timed out after ${timeoutMs}ms; terminating PID ${pid}.`);
          killTimedOutChild(pid);
        }
        try { child?.stdout?.destroy(); } catch {}
        try { child?.stderr?.destroy(); } catch {}
        try { child?.unref?.(); } catch {}
        finish({ stdout, error: `Timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      try {
        child = spawnCliTemplate(cli, template, {
          promptFile,
          promptText: prompt,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        finish({ stdout: "", error: err.message });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        if (stdout.length < maxBuffer) stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < maxBuffer) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => {
        finish({ stdout, error: err.message });
      });
      child.on("close", (status, signal) => {
        if (status === 0) {
          finish({ stdout });
          return;
        }
        const suffix = stderr ? `: ${stderr}` : "";
        const exit = signal ? `Signal ${signal}` : `Exit ${status}`;
        finish({ stdout, error: `${exit}${suffix}` });
      });
    });
  }
}

function killTimedOutChild(pid) {
  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  }, 2000).unref?.();
}

// Transactional validation for a parsed arbitration response.
//
// The orchestrator CLI is an LLM; nothing forces it to return a well-formed
// envelope. Before we apply ANY side effects (killing workers, committing
// worktrees, respawning, flipping requests.jsonl), every request that went
// into the prompt must come back out resolved (approved or rejected), and
// every action must tie back to an agent whose request actually was resolved
// in this same response.
//
// A failed cycle is recoverable: the pending requests stay pending, so the
// next tick re-renders the prompt and re-asks. A half-applied cycle (e.g. we
// killed a worker but never recorded why) is not.
//
// Returns { ok: true } when valid, otherwise { ok: false, reasons: string[] }.
function validateArbitrationResponse(response, pending) {
  if (!response || typeof response !== "object") {
    return { ok: false, reasons: ["Arbitration response is not an object."] };
  }
  const approved = Array.isArray(response.approved) ? response.approved : [];
  const rejected = Array.isArray(response.rejected) ? response.rejected : [];
  const actions = Array.isArray(response.actions) ? response.actions : [];
  const pendingList = Array.isArray(pending) ? pending : [];

  const approvedIds = new Set(approved.filter((a) => a && a.request_id).map((a) => a.request_id));
  const rejectedIds = new Set(rejected.filter((r) => r && r.request_id).map((r) => r.request_id));
  const resolvedIds = new Set([...approvedIds, ...rejectedIds]);

  const reasons = [];

  // Rule 1: every pending request must be in approved or rejected.
  const pendingIds = pendingList
    .filter((r) => r && r.request_id && r.status === "pending")
    .map((r) => r.request_id);
  const missingIds = pendingIds.filter((id) => !resolvedIds.has(id));
  if (missingIds.length > 0) {
    reasons.push(`Pending requests not in approved/rejected: ${missingIds.join(", ")}.`);
  }

  // Rule 2: every action must tie back to an agent whose request is resolved
  // in this same response. Catches an arbitrator that decides to restart or
  // end an agent without explaining what request prompted it.
  for (const action of actions) {
    if (!action || typeof action !== "object") {
      reasons.push("Action entry is not an object.");
      continue;
    }
    if (!["end_agent", "soft_restart", "hard_restart", "restart_agent"].includes(action.type)) {
      // Unknown action types are processed by processActions but contribute no
      // request-tying obligation; we let them through here.
      continue;
    }
    const agentName = typeof action.agent === "string" && action.agent.length > 0 ? action.agent : null;
    if (!agentName) {
      reasons.push(`Action ${action.type} missing 'agent'.`);
      continue;
    }
    // If the agent isn't in pending at all, the action is targeting a ghost —
    // dropUnknownAgentAction will log + drop it per-action. Don't reject the
    // whole response on that case; a single hallucinated action shouldn't be
    // able to poison legitimate approvals in the same envelope.
    const agentHasPending = pendingList.some(
      (r) => r && r.agent === agentName && r.request_id,
    );
    if (!agentHasPending) continue;
    const tiedToResolved = pendingList.some(
      (r) => r && r.agent === agentName && r.request_id && resolvedIds.has(r.request_id),
    );
    if (!tiedToResolved) {
      reasons.push(
        `Action ${action.type} targets agent '${agentName}' but no pending request for that agent was approved or rejected.`,
      );
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

module.exports = {
  RECENT_DECISION_LIMIT,
  ARBITRATION_PROMPT_CAP_BYTES,
  collectWorktreeStates,
  buildBoundedArbitrationPrompt,
  truncateMiddle,
  buildOrchestratorPrompt,
  callOrchestratorCli,
  validateArbitrationResponse,
};
