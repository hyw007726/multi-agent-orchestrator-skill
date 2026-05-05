import * as fs from "fs";
import * as lockfile from "proper-lockfile";

// Lock acquisition: spin briefly, give up after ~10s. `stale` covers a holder
// dying mid-update (e.g. orchestrator killed) so the next process isn't wedged.
const LOCK_OPTS: lockfile.LockOptions = {
  retries: { retries: 20, factor: 1.3, minTimeout: 50, maxTimeout: 1000 },
  stale: 30000,
};

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
