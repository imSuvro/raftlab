# raftlab — Product Requirements

## One-line

A Raft consensus implementation in TypeScript whose test harness — a
deterministic, seed-reproducible cluster simulator with fault injection and
linearizability checking — is the product, demonstrated live in a browser
playground where anyone can break a running cluster.

## Problem

The TypeScript/JavaScript Raft landscape is unmaintained or toy-grade, and
tested — where tested at all — with in-order unit tests and real-timer
integration scripts (see [research](research.md)). Meanwhile Antithesis
demonstrated safety violations in four mature production Raft implementations
using network turbulence alone. A green unit-test badge on a consensus
implementation proves nothing. The systems with real correctness records
(FoundationDB, TigerBeetle) got them the same way: a simulator that owns time,
the network, and the disk, drives the real code through seeded randomized
histories, and checks invariants continuously.

raftlab builds that harness for a from-scratch TypeScript Raft, and — because
the simulator is sans-IO and single-threaded — ships the identical simulator
to the browser as an interactive playground.

## Audience

1. **Senior engineers** evaluating the author's work: they read the bug log,
   the ADRs, and the invariant checkers before they read the Raft code.
2. **Playground visitors** with zero Raft background: the playground must be
   legible and enjoyable without reading anything first.
3. **Library users** (secondary): `@raftlab/core` and `@raftlab/sim` are
   publish-ready, documented, and usable outside this repo.

## In scope

| Capability | Definition of done |
|---|---|
| Leader election | Randomized timeouts, §5.2 vote rules, §5.4.1 up-to-date restriction; re-election visibly works under faults |
| Log replication | AppendEntries consistency check, conflict truncation, commit-index advancement with the §5.4.2 current-term rule, no-op entry on election win |
| Persistence | currentTerm/votedFor/log durable per the paper's "updated on stable storage before responding" rule; nodes crash and restart with storage intact |
| Client operations, linearizable | Writes and reads through the replicated log; unique op ids; indeterminate outcomes modeled honestly; histories pass a linearizability checker |
| Deterministic simulation | Single seeded PRNG; identical seed → byte-identical event trace, verified in CI on every run |
| Fault injection | Message delay/reorder/drop/duplicate; symmetric + asymmetric partitions; crash/restart; clock skew/drift |
| Invariant checking | Election safety, log matching, leader completeness, state-machine safety — checked continuously during simulation |
| Fuzz campaign | ≥5,000 seeds per full run across fault profiles; failing seed → minimized repro; every bug logged in docs/bugs.md |
| Playground | Live 5-node cluster on load; fault controls; timeline pause/step/scrub; shareable seed URLs; fully client-side |

## Explicitly deferred

- **Cluster membership changes** (§6). Fixed 5-node (configurable N) clusters.
- **Snapshots / log compaction** (§7). Logs grow unbounded; irrelevant at
  simulation and playground horizons.
- **ReadIndex / lease reads** (§8 optimizations). Reads go through the log —
  the simplest provably linearizable path; the optimization is documented as
  known future work.
- **Client session deduplication** (§8). The workload generator never retries
  with a reused op id; timeouts are recorded as indeterminate and the checker
  treats them accordingly.

Deferrals are stated in the README. None of them weaken the safety claims
being tested.

## Success criteria

1. **Every failure is reproducible from its seed.** A failing fuzz run prints
   a repro command; running it reproduces the identical violation and trace
   hash. No flaky failures exist by construction.
2. **Live playground** at a public URL: cluster animates on load, killing the
   leader triggers a visible re-election, partition + heal reconciles logs —
   verified interactively before launch.
3. **Documented bug log**: every bug the simulator finds in the author's own
   Raft is written up in docs/bugs.md with seed, minimized trace, root cause,
   and fix commit. The log is a launch asset, not an embarrassment.
4. Green CI on main including the fuzz job; determinism (double-run trace-hash
   equality) enforced on every PR.
5. `@raftlab/core` and `@raftlab/sim` pass publish checks (pack + type
   resolution) in CI.

## Non-goals and constraints

- **$0 spend**: static hosting only, no backend services, no telemetry.
- **No signup wall**: the playground is fully functional anonymously.
- **Determinism is inviolable**: any nondeterminism in core or sim is a bug,
  not a shortcut. `Date.now`, `Math.random`, and wall-clock timers are
  banned by lint in `packages/core` and `packages/sim`.
- **No copying existing Raft implementations**: the code is written from the
  paper; the research doc records what was read.
- Production networking (TCP transports, RPC frameworks) is out of scope; the
  core is sans-IO precisely so hosts can bring their own.

## Milestones

Stages 3–15 of the project plan, one tag each: feasibility spike → UX →
architecture ADRs → backlog → repo/CI → core → simulator → invariants → fuzz
campaign → playground → review → deploy → launch. PROJECT_LOG.md tracks
status.

## Risks

| Risk | Mitigation |
|---|---|
| Linearizability checker too slow for CI | Pre-designed two-tier fallback (fast real-time-order check on all seeds, full WGL on inconclusive/nightly); documented in an ADR; invariants never silently weakened |
| 5,000 seeds exceed CI wall-clock comfort | Tiered campaign (fixed 500-seed range on PR, full nightly); split recorded in the CI ADR |
| Fuzz findings that trace to misreading the paper | Flagged prominently in docs/bugs.md; adjacent logic re-verified before continuing |
| Playground performance on low-end devices | Sim runs in a worker; scrub-by-rerun measured in the spike; checkpointing held as a guarded fallback |
