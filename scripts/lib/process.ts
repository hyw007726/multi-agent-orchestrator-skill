import { execSync } from "child_process";

// Returns the cmdline of `pid` (best-effort), or null if the process is gone.
// Uses POSIX `ps` — macOS and Linux only. Windows callers should fall back to the
// raw process.kill behavior since we don't currently support it elsewhere.
export function getProcessCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = cmd.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// PIDs recycle. Before signalling, confirm the PID still belongs to a process whose
// cmdline mentions the CLI we spawned. Returns true if we can confidently send signals,
// false if the PID is gone or has been recycled to something unrelated.
export function pidMatchesCli(pid: number, expectedCli: string): boolean {
  if (!pid) return false;
  if (process.platform === "win32") {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  const cmdline = getProcessCommand(pid);
  if (!cmdline) return false;
  return cmdline.toLowerCase().includes(expectedCli.toLowerCase());
}

export interface KillOptions {
  pid: number;
  expectedCli: string;
  log: (msg: string) => void;
  signal?: NodeJS.Signals;
}

// Safe kill: only signals the PID if it still matches the spawned CLI. Logs the reason on skip.
export function safeKill({ pid, expectedCli, log, signal = "SIGTERM" }: KillOptions): boolean {
  if (!pid) return false;
  if (!pidMatchesCli(pid, expectedCli)) {
    log(`Skipping ${signal} on PID ${pid}: process is gone or no longer matches '${expectedCli}'.`);
    return false;
  }
  try {
    process.kill(pid, signal);
    log(`Sent ${signal} to PID ${pid} (${expectedCli}).`);
    return true;
  } catch (err: any) {
    if (err.code === "ESRCH") log(`PID ${pid} already exited.`);
    else log(`Failed to signal PID ${pid}: ${err.message}`);
    return false;
  }
}
