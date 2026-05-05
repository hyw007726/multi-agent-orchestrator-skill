import * as fs from "fs";
import * as path from "path";
import * as lockfile from "proper-lockfile";

// Lock acquisition: spin briefly, give up after ~10s. `stale` covers a holder
// dying mid-update (e.g. orchestrator killed) so the next process isn't wedged.
const LOCK_OPTS: lockfile.LockOptions = {
  retries: { retries: 20, factor: 1.3, minTimeout: 50, maxTimeout: 1000 },
  stale: 30000,
};

// Long-lived advisory lock taken once per orchestrator-loop process to make a second
// `nohup ... orchestrator-loop.ts --coord <same-dir>` invocation refuse to start
// instead of racing the first one (both arbitrating the same requests, both
// respawning the same agents, restart counts double-bumping). Held for the full
// lifetime of the loop; released on graceful exit and on SIGINT/SIGTERM.
//
// Returns a release function — proper-lockfile's `stale` option (60s) lets the
// next invocation take over automatically if the prior loop SIGKILL'd without
// running its teardown.
export function acquireInstanceLock(coordDir: string): { release: () => void; markerPath: string } {
  const instanceFile = path.join(coordDir, "orchestrator.instance");
  if (!fs.existsSync(instanceFile)) fs.writeFileSync(instanceFile, "");
  try {
    const release = lockfile.lockSync(instanceFile, {
      retries: 0,        // fail immediately so a second loop sees a clear error
      stale: 60_000,     // recover from a hard-killed predecessor after 60s
      realpath: false,
    });
    return {
      markerPath: instanceFile,
      release: () => {
        try { release(); } catch {}
      },
    };
  } catch (err: any) {
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
export function updateJSON<T>(filePath: string, mutate: (data: T) => T | void): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`updateJSON: file does not exist: ${filePath}. Run bootstrap first.`);
  }
  const release = lockfile.lockSync(filePath, LOCK_OPTS);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    const result = mutate(data);
    const toWrite = result === undefined ? data : result;
    writeAtomic(filePath, JSON.stringify(toWrite, null, 2) + "\n");
  } finally {
    release();
  }
}

// Atomic read-modify-write of a JSONL file. Same shape as updateJSON. Useful
// for marking request statuses without losing concurrent appends from workers
// (which use shell O_APPEND for atomic small writes); see the worker-append note
// in scripts/lib/locking.ts comments.
export function updateJSONL<T>(filePath: string, mutate: (lines: T[]) => T[] | void): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`updateJSONL: file does not exist: ${filePath}. Run bootstrap first.`);
  }
  const release = lockfile.lockSync(filePath, LOCK_OPTS);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) as T[];
    const result = mutate(data);
    const toWrite = result === undefined ? data : result;
    const content = toWrite.map((item) => JSON.stringify(item)).join("\n") + (toWrite.length > 0 ? "\n" : "");
    writeAtomic(filePath, content);
  } finally {
    release();
  }
}

// Unlocked read — fine for snapshots used to drive iteration / decisions when
// the actual mutation later goes through update*JSON. Doing a snapshot read
// during an in-progress write could yield stale data, but never partial data
// because writeAtomic uses tmp+rename.
export function readJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function readJSONL<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) as T[];
}

// Single-use helper — used by both update* functions above.
// Atomic write: stage to a sibling tmp file then rename. Concurrent readers
// either see the old contents or the new contents, never a half-written file.
function writeAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}
