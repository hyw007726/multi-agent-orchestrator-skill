# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)

## Medium (UX gaps, missing safety nets)

- [ ] **[C2] Wait-for-exit + SIGKILL escalation in `safeKill`**: `scripts/lib/process.js`'s `safeKill` sends one SIGTERM and returns immediately. Callers in `scripts/lib/actions.js` (`bumpRestartAndRespawn` around line 391) and `scripts/orchestrator-loop.js` (liveness-timeout path around line 199) then respawn into the same worktree or park the agent without confirming the old PID is gone. If a worker traps or delays SIGTERM (mid-network call, stuck syscall, CLI ignoring TERM during cleanup), two workers can briefly write to the same worktree. Add a wait-for-exit poll on the killed PID with a short grace window (e.g. 5s), escalate to SIGKILL on timeout, and only then respawn. Add a regression that asserts a respawn never starts while the previous PID is still alive.

- [ ] **[C1] Fsync parent directory after `writeAtomic` rename**: `scripts/lib/locking.js`'s `writeAtomic` (around lines 394-411) fsyncs the temp file fd, then renames into place — but never fsyncs the parent directory. On POSIX, the rename's directory entry is buffered separately, so a power loss / kernel panic between rename and the next implicit dir-sync can lose the rename even though the file body was durable. Open the parent directory and `fs.fsyncSync` it after `renameSync`. Low blast radius (matters only across power events / kernel panics), but closes a real durability gap in a system that is otherwise crash-safe.

- [ ] **[C1] Bound the `refusalCounts` map in `scripts/lib/process.js`**: the per-PID counter (lines 16-17) is deleted on match-success or fallback-fire, but if a PID disappears between checks (`pidMatchesCli` false, `processStillAlive` also false, fallback skipped) the entry leaks forever. Over a long-lived loop with many killed/recycled workers, the map grows monotonically. Drop the entry whenever `processStillAlive(pid)` returns false in the no-fallback branch (and/or LRU-cap the map). Add a small test that simulates dead-PID refusals and asserts the map size stays bounded.
