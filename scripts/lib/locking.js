const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// Short-lived RMW lock options (used by updateJSON / updateJSONL).
const LOCK_OPTS = { retries: 20, factor: 1.3, minTimeout: 50, maxTimeout: 1000, stale: 30000 };

// Long-lived advisory lock taken once per orchestrator-loop process to prevent a second
// invocation from racing the first (double-arbitrating requests, double-bumping restart
// counts). Held for the full lifetime of the loop; released on graceful exit / signals.
//
// Two layers of defence:
//   1) ps-scan for a live `orchestrator-loop.js --coord <same path>` first — catches the
//      case where someone removed a "stale" lock dir while a real loop was still running.
//   2) Standard mkdir-lock on `<instanceFile>.lock`.
// After both succeed, mint a fresh `run_id` and persist it to `coord/current_run.json` so
// every event/decision/recovery-tag emitted during this run can be stamped with it.
function acquireInstanceLock(coordDir) {
  const live = findRunningLoop(coordDir);
  if (live) {
    console.error(
      `Another orchestrator loop is already running on '${coordDir}' (PID ${live.pid}).\n` +
      `Refusing to start a second instance — concurrent loops would double-arbitrate ` +
      `pending requests and double-bump restart counts on the same agents.\n\n` +
      `Detected via ps scan: ${live.cmd}\n\n` +
      `If that process is wedged, stop it explicitly (e.g. \`kill ${live.pid}\`) before retrying.`,
    );
    process.exit(1);
  }

  const instanceFile = path.join(coordDir, "orchestrator.instance");
  if (!fs.existsSync(instanceFile)) fs.writeFileSync(instanceFile, "");
  try {
    const release = acquireLock(instanceFile, { retries: 0, stale: 60_000 });
    const runId = writeCurrentRunFile(coordDir);
    return {
      markerPath: instanceFile,
      runId,
      release: () => { try { release(); } catch {} },
    };
  } catch (err) {
    if (err && err.code === "ELOCKED") {
      const lockMarker = `${instanceFile}.lock`;
      console.error(
        `Another orchestrator loop is already running on '${coordDir}'.\n` +
        `Refusing to start a second instance — concurrent loops would double-arbitrate ` +
        `pending requests and double-bump restart counts on the same agents.\n\n` +
        `If you're certain no other loop is running (e.g. it crashed without cleanup), ` +
        `remove the stale lock marker:  rm -rf '${lockMarker}'`,
      );
      process.exit(1);
    }
    throw err;
  }

  // Single-use helper — only called from acquireInstanceLock above.
  // POSIX `ps` scan for a competing orchestrator-loop on the same coord directory.
  // Returns { pid, cmd } if a live loop matches, otherwise null. Best-effort: on
  // Windows or when `ps` is unavailable we return null and rely on the mkdir-lock.
  //
  // Path comparison resolves the other process's `--coord` relative to ITS cwd
  // (via /proc/<pid>/cwd on Linux or `lsof` on macOS). Without that, identical
  // relative spellings like `--coord ./coord` from two unrelated project dirs
  // would falsely collide.
  function findRunningLoop(coordDir) {
    if (process.platform === "win32") return null;
    const targetCoord = safeResolve(coordDir);
    if (!targetCoord) return null;
    const result = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf-8", timeout: 2000 });
    if (!result || result.status !== 0 || !result.stdout) return null;

    for (const rawLine of result.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const cmd = match[2];
      if (!Number.isInteger(pid) || pid === process.pid || pid === process.ppid) continue;
      if (!cmd.includes("orchestrator-loop.js")) continue;

      const otherCoord = extractCoordArg(cmd);
      if (!otherCoord) continue;

      // Absolute path ⇒ direct comparison is safe regardless of cwd.
      if (path.isAbsolute(otherCoord)) {
        if (safeResolve(otherCoord) === targetCoord) return { pid, cmd };
        continue;
      }

      // Relative path ⇒ resolve against the other process's cwd, else skip. The
      // mkdir-lock still catches same-cwd duplicates we miss here.
      const otherCwd = readProcessCwd(pid);
      if (!otherCwd) continue;
      const otherResolved = safeResolve(path.resolve(otherCwd, otherCoord));
      if (otherResolved && otherResolved === targetCoord) return { pid, cmd };
    }
    return null;

    // Nested helpers — only used inside findRunningLoop.
    function extractCoordArg(cmd) {
      const eq = cmd.match(/--coord=("([^"]+)"|'([^']+)'|(\S+))/);
      if (eq) return eq[2] || eq[3] || eq[4] || "";
      const space = cmd.match(/--coord\s+("([^"]+)"|'([^']+)'|(\S+))/);
      if (space) return space[2] || space[3] || space[4] || "";
      return "";
    }
    function safeResolve(p) {
      try { return path.resolve(p); } catch { return ""; }
    }
    function readProcessCwd(pid) {
      // Linux: /proc/<pid>/cwd is a symlink to the cwd.
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd) return cwd;
      } catch {}
      // macOS/BSD: ask lsof. `-Fn` prints only newline-prefixed name lines.
      const lsof = spawnSync("lsof", ["-p", String(pid), "-a", "-d", "cwd", "-Fn"], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (lsof && lsof.status === 0 && lsof.stdout) {
        for (const ln of lsof.stdout.split("\n")) {
          if (ln.startsWith("n")) return ln.slice(1);
        }
      }
      return "";
    }
  }

  // Single-use helper — only called from acquireInstanceLock above.
  // Mints a fresh run_id and writes coord/current_run.json. Stamp source for events,
  // decisions, and recovery tags throughout this run.
  function writeCurrentRunFile(coordDir) {
    const startedAt = new Date().toISOString();
    const runId = `run-${startedAt.replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
    try {
      writeAtomic(path.join(coordDir, "current_run.json"), JSON.stringify({
        run_id: runId,
        started_at: startedAt,
        pid: process.pid,
      }, null, 2) + "\n");
    } catch {
      // Best-effort: even if persistence fails, the loop owns runId in-memory and
      // can keep stamping in-process emissions.
    }
    return runId;
  }
}

// Read the current run_id (if any) from coord/current_run.json. Subprocesses
// (spawn-agent, resume-agent, etc.) use this to stamp their own events with the
// active run_id without each having to thread it through their argv.
function readCurrentRunId(coordDir) {
  if (!coordDir) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(coordDir, "current_run.json"), "utf-8"));
    if (data && typeof data.run_id === "string" && data.run_id !== "") return data.run_id;
  } catch {}
  return null;
}

// Atomic read-modify-write of a JSON file. The mutator may either mutate `data`
// in place or return a new value. The lock is held only for the duration of the
// read+mutate+write — never across a subprocess call.
function updateJSON(filePath, mutate) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`updateJSON: file does not exist: ${filePath}. Run bootstrap first.`);
  }
  const release = acquireLock(filePath, LOCK_OPTS);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const result = mutate(data);
    const toWrite = result === undefined ? data : result;
    writeAtomic(filePath, JSON.stringify(toWrite, null, 2) + "\n");
  } finally {
    release();
  }
}

// Atomic read-modify-write of a JSONL file. Same shape as updateJSON. The
// orchestrator owns requests.jsonl; workers write request files into coord/requests/.
function updateJSONL(filePath, mutate) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`updateJSONL: file does not exist: ${filePath}. Run bootstrap first.`);
  }
  const release = acquireLock(filePath, LOCK_OPTS);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = raw.split("\n").map(l => l.trim()).filter(l => l !== "" && !l.startsWith("\`\`\`")).reduce((acc, l) => {
      try {
        acc.push(JSON.parse(l));
      } catch (e) {
        console.error(`Warning: updateJSONL skipping malformed line: ${l}`);
      }
      return acc;
    }, []);
    const result = mutate(data);
    const toWrite = result === undefined ? data : result;
    const content = toWrite.map((item) => JSON.stringify(item)).join("\n") + (toWrite.length > 0 ? "\n" : "");
    writeAtomic(filePath, content);
  } finally {
    release();
  }
}

// Append-only JSONL write. Used for audit logs where old entries must never be
// discarded to keep prompt-sized snapshot files small.
function appendJSONL(filePath, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const release = acquireLock(filePath, LOCK_OPTS);
  try {
    const content = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    fs.appendFileSync(filePath, content);
  } finally {
    release();
  }
}

// Unlocked read — fine for snapshots used to drive iteration / decisions when the actual
// mutation later goes through update*JSON. Never yields partial data because writeAtomic
// uses tmp+rename.
function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// Skips malformed lines (log+continue) rather than throwing — one bad line in
// requests.jsonl must not wedge the loop forever. Mirrors updateJSONL's policy.
function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l !== "").reduce((acc, l) => {
    try {
      acc.push(JSON.parse(l));
    } catch {
      console.error(`Warning: readJSONL skipping malformed line in ${filePath}: ${l}`);
    }
    return acc;
  }, []);
}

// Shared — used by acquireInstanceLock, updateJSON, and updateJSONL.
// Acquires a .lock directory and guarantees that, from the perspective of any
// concurrent acquirer, the dir either does not exist or contains a fully
// written `pid` file. Stale locks are detected by checking if the holder PID is
// still alive; the mtime fallback covers genuinely corrupted lock dirs.
//
// Atomicity model: stage the lock content (mkdir + write pid) into a sibling
// staging dir, then rename it onto the target. POSIX `rename` of a dir onto a
// non-empty dir fails with ENOTEMPTY/EEXIST, which is the "lock already held"
// signal. Crucially, a concurrent acquirer can never observe a freshly-minted
// lock dir whose pid file hasn't landed yet — the previous mkdir-then-write
// shape allowed exactly that window, which let mtime-fallback nuke a brand-new
// valid lock.
function acquireLock(filePath, opts = {}) {
  const { retries = 20, factor = 1.3, minTimeout = 50, maxTimeout = 1000, stale = 30000 } = opts;
  const lockDir = `${filePath}.lock`;
  const pidFile = path.join(lockDir, "pid");

  let delay = minTimeout;
  for (let i = 0; i <= retries; i++) {
    if (fs.existsSync(lockDir)) {
      try {
        const lockPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
        if (!processAlive(lockPid)) atomicRemoveLock(lockDir);
      } catch {
        try {
          if (Date.now() - fs.statSync(lockDir).mtimeMs > stale) atomicRemoveLock(lockDir);
        } catch {}
      }
    }

    const stagingDir = `${lockDir}.staging.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}`;
    try {
      fs.mkdirSync(stagingDir);
      fs.writeFileSync(path.join(stagingDir, "pid"), String(process.pid));
    } catch (err) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      throw err;
    }

    try {
      fs.renameSync(stagingDir, lockDir);
      return () => atomicRemoveLock(lockDir);
    } catch (err) {
      // `rename` onto a populated dir fails with ENOTEMPTY (Linux) or EEXIST
      // (macOS/BSD on some setups) — both mean someone else got the lock first.
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      if (err.code !== "ENOTEMPTY" && err.code !== "EEXIST") throw err;
      if (i === retries) throw Object.assign(new Error(`Lock already held: ${lockDir}`), { code: "ELOCKED" });
      sleepSync(Math.min(delay, maxTimeout));
      delay = Math.min(delay * factor, maxTimeout);
    }
  }

  function processAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
  }
}

// Shared — used by acquireLock's release callback and its stale-cleanup branch.
// Atomically removes a lock directory so concurrent acquirers never observe a
// half-removed dir (which `rmSync(..., recursive: true)` produces because it
// unlinks the pid file before removing the directory itself). Rename is atomic;
// the subsequent recursive delete happens on a path no one else is watching.
function atomicRemoveLock(lockDir) {
  const releasing = `${lockDir}.releasing.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}`;
  try {
    fs.renameSync(lockDir, releasing);
  } catch {
    // Rename failed (likely already gone). Fall back to best-effort cleanup
    // on the original path; if it really is gone, this is a no-op.
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
    return;
  }
  try { fs.rmSync(releasing, { recursive: true, force: true }); } catch {}
}

// Shared — used by updateJSON and updateJSONL.
// Atomic write: stage to a sibling tmp file then rename. Concurrent readers see either
// the old contents or the new contents, never a half-written file.
function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

module.exports = { acquireInstanceLock, readCurrentRunId, updateJSON, updateJSONL, appendJSONL, readJSON, readJSONL, acquireLock, writeAtomic };
