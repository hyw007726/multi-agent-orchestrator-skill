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

// PIDs recycle. Before signalling, confirm the PID still belongs to a process whose
// cmdline matches what we spawned. Returns true if we can confidently send signals,
// false if the PID is gone or has been recycled to something unrelated.
//
// `recordedCmdline` (optional) is the full `ps -o command=` output captured at
// spawn time. It's a stronger signal than the template basename because some
// CLIs mutate `process.title` at runtime, breaking the substring rule. When
// the live cmdline still starts with the same binary path as the recorded one,
// we accept the match.
function pidMatchesCli(pid, expectedCli, { recordedCmdline } = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid || !expectedCli) return false;
  if (process.platform === "win32") {
    try { process.kill(normalizedPid, 0); return true; } catch { return false; }
  }
  const cmdline = getProcessCommand(normalizedPid);
  if (!cmdline) return false;

  if (cmdline.toLowerCase().includes(expectedCli.toLowerCase())) return true;
  if (typeof recordedCmdline === "string" && recordedCmdline.trim() !== "") {
    if (cmdline === recordedCmdline) return true;
    const liveBin = firstToken(cmdline);
    const recordedBin = firstToken(recordedCmdline);
    if (liveBin && liveBin === recordedBin) return true;
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

function firstToken(value) {
  const match = typeof value === "string" ? value.match(/\S+/) : null;
  return match ? match[0] : "";
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
  pidMatchesCli,
  safeKill,
  REFUSAL_FALLBACK_THRESHOLD,
  _resetRefusalCounts,
};
