# TODO

Each item is tagged with a complexity rating:

- **[C1]** - easy, localized change that touches only one or two files.
- **[C2]** - multi-file change, some design judgment, moderate test surface.
- **[C3]** - architectural or protocol change that touches several subsystems.

> Items already on `Roadmap.md` are not duplicated here.

---

## Critical (correctness, data loss, security)

## Medium (UX gaps, missing safety nets)

- [ ] **[C1] Bound the `refusalCounts` map in `scripts/lib/process.js`**: the per-PID counter (lines 16-17) is deleted on match-success or fallback-fire, but if a PID disappears between checks (`pidMatchesCli` false, `processStillAlive` also false, fallback skipped) the entry leaks forever. Over a long-lived loop with many killed/recycled workers, the map grows monotonically. Drop the entry whenever `processStillAlive(pid)` returns false in the no-fallback branch (and/or LRU-cap the map). Add a small test that simulates dead-PID refusals and asserts the map size stays bounded.
