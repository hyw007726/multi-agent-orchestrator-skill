const { spawnSync } = require("child_process");
const { appendEvent } = require("./events");

// Returns the cmdline of `pid` (best-effort), or null if the process is gone.
// Uses POSIX `ps` — macOS and Linux only. Windows callers fall back to raw process.kill.
function getProcessCommand(pid) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return null;
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-p", String(normalizedPid), "-o", "command="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed || null;
}

// PIDs recycle. Before signalling, confirm the PID still belongs to a process whose
// cmdline mentions the CLI we spawned. Returns true if we can confidently send signals,
// false if the PID is gone or has been recycled to something unrelated.
function pidMatchesCli(pid, expectedCli) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid || !expectedCli) return false;
  if (process.platform === "win32") {
    try { process.kill(normalizedPid, 0); return true; } catch { return false; }
  }
  const cmdline = getProcessCommand(normalizedPid);
  if (!cmdline) return false;
  return cmdline.toLowerCase().includes(expectedCli.toLowerCase());
}

// Safe kill: only signals the worker if its leader PID still matches the spawned CLI.
// On POSIX, spawn-agent starts workers with detached:true, which makes child.pid the
// process group id. Signal the negative pid so wrapper shells and descendant CLIs stop together.
// Optional coordDir and agent params enable structured event emission for debugging.
function safeKill({ pid, expectedCli, log, signal = "SIGTERM", coordDir, agent } = {}) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) return false;
  if (!pidMatchesCli(normalizedPid, expectedCli)) {
    log(`Skipping ${signal} on PID ${normalizedPid}: process is gone or no longer matches '${expectedCli}'.`);
    return false;
  }

  const useProcessGroup = process.platform !== "win32";
  const target = useProcessGroup ? -normalizedPid : normalizedPid;
  const targetLabel = useProcessGroup ? `process group ${normalizedPid}` : `PID ${normalizedPid}`;

  try {
    process.kill(target, signal);
    log(`Sent ${signal} to ${targetLabel} (${expectedCli}).`);
    if (coordDir) {
      appendEvent(coordDir, "signal_sent", {
        agent,
        pid: normalizedPid,
        reason: `${signal} to ${targetLabel} (${expectedCli})`,
        data: useProcessGroup ? { process_group_id: normalizedPid } : undefined,
      });
    }
    return true;
  } catch (err) {
    if (useProcessGroup && err.code === "ESRCH") {
      return safeKillPidFallback(normalizedPid, expectedCli, signal, log, coordDir, agent);
    }
    if (err.code === "ESRCH") log(`${targetLabel} already exited.`);
    else log(`Failed to signal ${targetLabel}: ${err.message}`);
    return false;
  }
}

function safeKillPidFallback(pid, expectedCli, signal, log, coordDir, agent) {
  try {
    process.kill(pid, signal);
    log(`Sent ${signal} to PID ${pid} (${expectedCli}); process group ${pid} was not available.`);
    if (coordDir) {
      appendEvent(coordDir, "signal_sent", {
        agent,
        pid,
        reason: `${signal} to PID ${pid} (${expectedCli}); process group unavailable`,
      });
    }
    return true;
  } catch (err) {
    if (err.code === "ESRCH") log(`PID ${pid} already exited.`);
    else log(`Failed to signal process group ${pid} or PID ${pid}: ${err.message}`);
    return false;
  }
}

function normalizePid(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return null;
  return normalized;
}

module.exports = { getProcessCommand, pidMatchesCli, safeKill };
