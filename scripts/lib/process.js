const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { appendEvent } = require("./events");
const { tailLines } = require("./log-tail");

// How many consecutive pidMatchesCli refusals on the same PID before safeKill
// will consult events.jsonl and fall back to signalling anyway. Refusals reset
// the moment a check succeeds (or the PID disappears), so a steady stream of
// failures is what trips the fallback.
const REFUSAL_FALLBACK_THRESHOLD = 3;

// Per-PID counter for consecutive refused match checks. Lives in module state
// because safeKill is called from multiple sites in the orchestrator loop —
// hoisting the counter avoids requiring callers to thread it through.
const refusalCounts = new Map();

// Returns the cmdline of `pid` (best-effort), or null if the process is gone.
// Uses POSIX `ps` — macOS and Linux only. Windows callers fall back to raw process.kill.
function getProcessCommand(pid) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-p", String(normalizedPid), "-o", "command="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed || null;
}

// Returns a Map<pid, cmdline> built from one `ps -eo pid=,command=` invocation.
// Callers that need to liveness-check many pids per tick (the orchestrator
// loop iterates every running agent on every cycle) pass the returned map to
// pidMatchesCli so each lookup is in-memory instead of spawning ps per pid.
// Empty map on Windows or when ps fails — the caller's getProcessCommand
// fallback inside pidMatchesCli still covers those cases.
function getProcessCommandMap() {
  if (process.platform === "win32") return new Map();
  const result = spawnSync("ps", ["-eo", "pid=,command="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  if (!result || result.status !== 0 || !result.stdout) return new Map();
  const map = new Map();
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid)) continue;
    map.set(pid, match[2]);
  }
  return map;
}

// PIDs recycle. Before signalling, confirm the PID still belongs to a process whose
// cmdline matches what we spawned. Returns true if we can confidently send signals,
// false if the PID is gone or has been recycled to something unrelated.
//
// `recordedCmdline` (optional) is the full `ps -o command=` output captured at
// spawn time. It's a stronger signal than the template basename because shell
// and node wrappers often make the live first argv token `sh` or `node` while
// the actual CLI appears later in the command. In that case, require both the
// live and recorded cmdlines to contain the expected CLI as a path-aware token
// before accepting the fallback.
function pidMatchesCli(pid, expectedCli, { recordedCmdline, cmdMap } = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid || !expectedCli) return false;
  if (process.platform === "win32") {
    try { process.kill(normalizedPid, 0); return true; } catch { return false; }
  }
  // Prefer the per-cycle ps map if the caller built one. A miss in the map
  // means either the pid is gone or the map was captured before this process
  // came into being — fall back to a per-pid ps so freshly-spawned workers
  // aren't reported dead just because we caught them between ps snapshots.
  let cmdline = null;
  if (cmdMap instanceof Map) {
    cmdline = cmdMap.get(normalizedPid) ?? null;
    if (!cmdline) cmdline = getProcessCommand(normalizedPid);
  } else {
    cmdline = getProcessCommand(normalizedPid);
  }
  if (!cmdline) return false;

  const liveBin = firstArgBasename(cmdline);
  const expectedBin = cliBasename(expectedCli);
  if (liveBin && expectedBin && liveBin === expectedBin) return true;

  if (typeof recordedCmdline === "string" && recordedCmdline.trim() !== "") {
    if (cmdline === recordedCmdline) return true;
    const recordedBin = firstArgBasename(recordedCmdline);
    if (
      liveBin &&
      recordedBin &&
      liveBin === recordedBin &&
      commandLineContainsCliToken(cmdline, expectedBin) &&
      commandLineContainsCliToken(recordedCmdline, expectedBin)
    ) {
      return true;
    }
  }
  return false;
}

// Safe kill: only signals the worker if its leader PID still matches the spawned CLI.
// On POSIX, spawn-agent starts workers with detached:true, which makes child.pid the
// process group id. Signal the negative pid so wrapper shells and descendant CLIs stop together.
// Optional coordDir and agent params enable structured event emission for debugging.
//
// When pidMatchesCli refuses but events.jsonl confirms we spawned the PID
// (and there is no later process_exited event for it), safeKill falls back to
// signalling anyway after REFUSAL_FALLBACK_THRESHOLD consecutive refusals.
// This covers the case where a CLI mutated `process.title` so badly that
// neither the template basename nor the recorded cmdline still matches.
function safeKill({ pid, expectedCli, log, signal = "SIGTERM", coordDir, agent, recordedCmdline } = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return false;

  if (pidMatchesCli(normalizedPid, expectedCli, { recordedCmdline })) {
    refusalCounts.delete(normalizedPid);
    return dispatchKill(normalizedPid, expectedCli, signal, log, coordDir, agent, { fallback: false });
  }

  const nextCount = (refusalCounts.get(normalizedPid) || 0) + 1;
  refusalCounts.set(normalizedPid, nextCount);

  const fallback = nextCount >= REFUSAL_FALLBACK_THRESHOLD
    && processStillAlive(normalizedPid)
    && eventsConfirmWeSpawned(coordDir, normalizedPid);
  if (fallback) {
    log(`safeKill fallback: PID ${normalizedPid} refused match ${nextCount}× and events.jsonl shows we spawned it; signalling ${signal} anyway.`);
    refusalCounts.delete(normalizedPid);
    return dispatchKill(normalizedPid, expectedCli, signal, log, coordDir, agent, { fallback: true });
  }

  log(`Skipping ${signal} on PID ${normalizedPid}: process is gone or no longer matches '${expectedCli}' (refusal ${nextCount}/${REFUSAL_FALLBACK_THRESHOLD}).`);
  return false;
}

// Shared — invoked from both the happy path and the post-fallback path in
// safeKill above.
function dispatchKill(pid, expectedCli, signal, log, coordDir, agent, { fallback }) {
  const useProcessGroup = process.platform !== "win32";
  const target = useProcessGroup ? -pid : pid;
  const targetLabel = useProcessGroup ? `process group ${pid}` : `PID ${pid}`;
  const reasonSuffix = fallback ? " [fallback: refused match]" : "";

  try {
    process.kill(target, signal);
    log(`Sent ${signal} to ${targetLabel} (${expectedCli})${reasonSuffix}.`);
    if (coordDir) {
      appendEvent(coordDir, "signal_sent", {
        agent,
        pid,
        reason: `${signal} to ${targetLabel} (${expectedCli})${reasonSuffix}`,
        data: useProcessGroup ? { process_group_id: pid, fallback: fallback || undefined } : { fallback: fallback || undefined },
      });
    }
    return true;
  } catch (err) {
    if (useProcessGroup && err.code === "ESRCH") {
      return safeKillPidFallback(pid, expectedCli, signal, log, coordDir, agent, fallback);
    }
    if (err.code === "ESRCH") log(`${targetLabel} already exited.`);
    else log(`Failed to signal ${targetLabel}: ${err.message}`);
    return false;
  }
}

function safeKillPidFallback(pid, expectedCli, signal, log, coordDir, agent, fallback = false) {
  try {
    process.kill(pid, signal);
    const reasonSuffix = fallback ? " [fallback: refused match]" : "";
    log(`Sent ${signal} to PID ${pid} (${expectedCli})${reasonSuffix}; process group ${pid} was not available.`);
    if (coordDir) {
      appendEvent(coordDir, "signal_sent", {
        agent,
        pid,
        reason: `${signal} to PID ${pid} (${expectedCli})${reasonSuffix}; process group unavailable`,
        data: { fallback: fallback || undefined },
      });
    }
    return true;
  } catch (err) {
    if (err.code === "ESRCH") log(`PID ${pid} already exited.`);
    else log(`Failed to signal process group ${pid} or PID ${pid}: ${err.message}`);
    return false;
  }
}

// `kill(pid, 0)` is the POSIX way to probe existence without delivering a
// signal. We use it instead of getProcessCommand here so a hardened cmdline
// (where `ps` returns nothing) can still trip the fallback.
function processStillAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // EPERM ⇒ process exists but we lack permission.
  }
}

// Reads the tail of events.jsonl and returns true iff the most recent event
// referencing `pid` is an `agent_spawned` (i.e., we created it and have no
// record of it exiting since). Cheap by design — uses log-tail's seek-from-end
// reader so even a multi-MB events.jsonl is fine.
function eventsConfirmWeSpawned(coordDir, pid) {
  if (!coordDir) return false;
  const eventsPath = path.join(coordDir, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return false;

  const tail = tailLines(eventsPath, 500, { maxBytes: 512 * 1024 });
  if (!tail) return false;

  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.pid !== pid) continue;
    return record.event === "agent_spawned";
  }
  return false;
}

function commandLineContainsCliToken(cmdline, expectedBin) {
  if (!expectedBin) return false;
  return commandLineTokens(cmdline).some((token) => cliBasename(token) === expectedBin);
}

function commandLineTokens(value) {
  if (typeof value !== "string") return [];
  const tokens = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match;
  while ((match = re.exec(value)) !== null) {
    tokens.push(match[1] || match[2] || match[3] || "");
  }
  return tokens;
}

function firstArgBasename(value) {
  return cliBasename(commandLineTokens(value)[0] || "");
}

function cliBasename(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.basename(text).replace(/\.(cmd|exe)$/i, "").toLowerCase();
}

function normalizePid(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return null;
  return normalized;
}

// Test-only: reset the per-PID refusal counter so unit tests can re-run safeKill
// with a clean slate. Not part of the public API.
function _resetRefusalCounts() {
  refusalCounts.clear();
}

module.exports = {
  getProcessCommand,
  getProcessCommandMap,
  pidMatchesCli,
  safeKill,
  REFUSAL_FALLBACK_THRESHOLD,
  _resetRefusalCounts,
};
