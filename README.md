# raftlab

**Raft consensus in TypeScript, with a deterministic simulator that tries to break it — and a browser playground where you can too.**

🔴 **[Break a live cluster →](https://raftlab-suvros-projects.vercel.app)**

Five nodes are already running when the page loads. Kill the leader and watch
a new one get elected. Split the network and watch the logs diverge, then heal
it and watch them reconcile. Every run is reproducible from its seed, so the
URL you share replays exactly what you saw.

---

## Why this exists

Consensus implementations are easy to write and hard to trust. Antithesis
pointed their platform at four mature, production-hardened Raft
implementations — HashiCorp Raft, Aeron Cluster, OpenRaft, MicroRaft — and
found safety violations in every one, within an hour, using network faults
alone. A green unit-test badge on a consensus library proves very little.

The systems with real correctness records got them a different way.
FoundationDB built its simulator before the database. TigerBeetle's VOPR runs
its real cluster code against network, storage, and process faults at 1000×
speed. The pattern is the same: own time, the network, and the disk; drive the
real code through seeded randomized histories; check invariants continuously;
make every failure replayable from one number.

**raftlab is that harness, built for a Raft written from the paper.** The
tests are the product — the playground just makes them watchable.

## What's inside

| Package | What it is |
|---|---|
| [`@raftlab/core`](packages/core) | The Raft state machine. **Sans-IO**: no timers, no sockets, no clock, no randomness. `step(state, input) → Effect[]`. Zero dependencies. |
| [`@raftlab/sim`](packages/sim) | The deterministic simulator: virtual time, seeded fault injection, invariant + linearizability checking, seed-exact replay. |
| [`apps/playground`](apps/playground) | The same core and simulator, running in a web worker in your browser. |

### The core is sans-IO

The protocol never touches the outside world. It consumes inputs and returns
an ordered list of effects; the environment owns time, randomness, the
network, and storage.

```ts
const { state, effects } = init(config, recoveredFromDisk);
const more = step(state, { type: 'message', from: 2, msg, now });
// effects: [{ type: 'persist', hardState }, { type: 'send', to: 3, msg }, …]
```

That single design choice is what makes everything else possible. There is no
clock to mock and no scheduler to fight — the simulator simply decides what
happens next. The environment must make each `persist` effect durable before
acting on any effect after it, which is how the paper's "update stable storage
before responding to RPCs" rule becomes a type-level contract rather than a
comment.

### The simulator is deterministic, and that's enforced

One seed drives four independent PRNG streams (network, timers, faults,
workload). Events run on a binary heap ordered by `(virtualTime, sequence)`,
so ties break identically every time. Every run hashes its event trace, and
CI runs every scenario twice and compares hashes on every pull request.
`Date.now`, `Math.random`, and host timers are **lint-banned** in both
packages — determinism is a build error, not a code review note.

Faults available: message delay, drop, duplication and reordering; symmetric
partitions and one-way link failures; node crash and restart with storage
intact; clock skew and drift.

### The checkers run continuously

All five safety properties from Figure 3 of the paper — election safety, log
matching, leader append-only, leader completeness, state machine safety — are
checked after **every single step**, incrementally. Client operation histories
go through a per-key Wing & Gong linearizability checker. Every checker is
tested by fabricating the violation it's supposed to catch.

### Failures are reproducible by construction

When an invariant trips, the fuzzer minimizes the scenario — delta-debugging
the fault script and the client workload with the seed held fixed — and writes
a self-contained artifact:

```bash
pnpm fuzz --seeds 0:5000 --profile all   # ~2 minutes
pnpm repro fuzz-failures/failure-8472.json
# → REPRODUCED: same violation, same trace 0x9f3c1a20
```

Because the playground and the fuzzer share a scenario format, a failing seed
can also be **opened in the browser and watched**.

## Results

**10,000 seeds across four fault profiles: zero safety or linearizability
violations**, at roughly 2,600 seeds/minute with all checkers armed.

The core reached that campaign after heavy verification: 70 curated tests
drawn from the paper's Figures 6, 7 and 8 plus hostile-delivery suites, three
adversarial audit passes, and a 500-run randomized probe.

The bugs the campaign *did* find were in the verification stack itself — a
32-bit mask overflow in the linearizability checker, and a minimizer that
returned non-minimal repros. Both are written up, with the triage, in
**[docs/bugs.md](docs/bugs.md)** — including one reported violation that
turned out to indict the test driver rather than the protocol.

## Scope

**Implemented:** leader election, log replication, persistence, and
linearizable client operations (reads go through the log).

**Deliberately deferred**, and documented rather than hidden: cluster
membership changes (§6), snapshots and log compaction (§7), ReadIndex/lease
reads (§8 optimizations), and client session deduplication.

## Try it locally

```bash
pnpm install
pnpm test                              # 117 tests, including determinism
pnpm fuzz --seeds 0:1000 --profile all
pnpm --filter raftlab-playground dev
```

## Documentation

- **[docs/bugs.md](docs/bugs.md)** — every bug, with seeds, root causes, and fixes
- [docs/research.md](docs/research.md) — the paper, the prior art, the gap analysis
- [docs/adr/](docs/adr/) — six architecture decision records
- [docs/ux.md](docs/ux.md) — the playground's design and data contract
- [PROJECT_LOG.md](PROJECT_LOG.md) — the build log, stage by stage

Built from the Raft paper (Ongaro & Ousterhout, extended version). No existing
implementation was copied.

## License

MIT
