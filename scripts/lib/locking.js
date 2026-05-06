const fs = require("fs");
const path = require("path");

// Short-lived RMW lock options (used by updateJSON / updateJSONL).
const LOCK_OPTS = { retries: 20, factor: 1.3, minTimeout: 50, maxTimeout: 1000, stale: 30000 };

// Long-lived advisory lock taken once per orchestrator-loop process to prevent a second
// invocation from racing the first (double-arbitrating requests, double-bumping restart
// counts). Held for the full lifetime of the loop; released on graceful exit / signals.
function acquireInstanceLock(coordDir) {
  const instanceFile = path.join(coordDir, "orchestrator.instance");
  if (!fs.existsSync(instanceFile)) fs.writeFileSync(instanceFile, "");
  try {
    const release = acquireLock(instanceFile, { retries: 0, stale: 60_000 });
    return {
      markerPath: instanceFile,
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

// Atomic read-modify-write of a JSONL file. Same shape as updateJSON. Useful for marking
// request statuses without losing concurrent appends from workers (shell O_APPEND).
function updateJSONL(filePath, mutate) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`updateJSONL: file does not exist: ${filePath}. Run bootstrap first.`);
  }
  const release = acquireLock(filePath, LOCK_OPTS);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const result = mutate(data);
    const toWrite = result === undefined ? data : result;
    const content = toWrite.map((item) => JSON.stringify(item)).join("\n") + (toWrite.length > 0 ? "\n" : "");
    writeAtomic(filePath, content);
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

function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

// Shared — used by acquireInstanceLock, updateJSON, and updateJSONL.
// Acquires a .lock directory (mkdirSync is atomic on POSIX: EEXIST if already held).
// Detects stale locks by checking if the holder PID is still alive; falls back to
// mtime-based staleness if the PID file is unreadable.
function acquireLock(filePath, opts = {}) {
  const { retries = 20, factor = 1.3, minTimeout = 50, maxTimeout = 1000, stale = 30000 } = opts;
  const lockDir = `${filePath}.lock`;
  const pidFile = path.join(lockDir, "pid");

  let delay = minTimeout;
  for (let i = 0; i <= retries; i++) {
    if (fs.existsSync(lockDir)) {
      try {
        const lockPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
        if (!processAlive(lockPid)) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        try {
          if (Date.now() - fs.statSync(lockDir).mtimeMs > stale) {
            fs.rmSync(lockDir, { recursive: true, force: true });
          }
        } catch {}
      }
    }

    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, String(process.pid));
      return () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
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

// Shared — used by updateJSON and updateJSONL.
// Atomic write: stage to a sibling tmp file then rename. Concurrent readers see either
// the old contents or the new contents, never a half-written file.
function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

module.exports = { acquireInstanceLock, updateJSON, updateJSONL, readJSON, readJSONL };
