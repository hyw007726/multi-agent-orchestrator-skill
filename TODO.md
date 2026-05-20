# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)


## Medium (UX gaps, missing safety nets)

## Test gaps

- [x] **[C2] Crash mid-`processApprovals`**: write a test that injects a fault between `appendDecisionRecords` and `updateJSONL`, then reboots the loop and confirms no request is re-arbitrated.
- [x] **[C2] Concurrent lock acquire**: spawn N parallel `acquireLock` callers against the same file and assert no caller sees a half-formed lock (no missing pid file, no premature stale-cleanup).
- [x] **[C2] Per-cycle subprocess count**: assert that with 10 running agents, one main-loop tick spawns at most one `ps` and at most one `git` per agent (regression for the perf fix above).
- [x] **[C2] Coord symlink subtree ownership**: simulate a worker writing `coord/requests/foo.json` via the symlink and assert ownership check passes.
- [x] **[C2] Submodule survives `captureRecoveryAndReset`**: stage a `.gitmodules` entry in a worker worktree, trigger a hard restart, and assert the submodule path is preserved (or the hard restart refuses).
