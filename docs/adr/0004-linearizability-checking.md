# ADR-0004: Linearizability checking approach

**Status:** Accepted / **Date:** 2026-08-29 / **Deciders:** Suvra Samajder

## Context

The five Raft safety properties (research.md, Figure 3) are internal oracles: they check what
replicas believe, per tick, against the simulator's canonical history. They say nothing about what
*clients* observed. A cluster can satisfy State Machine Safety and still serve a stale read from a
deposed leader — the class of bug Raft's §8 machinery (term-start no-op, deposal check) exists to
prevent, and one that raftlab's initial design makes checkable end-to-end because reads are routed
through the log like writes (research.md, "Client interaction"). Linearizability at the client
boundary is therefore the top of the checking stack: the one property that subsumes "the cluster
behaved like a single correct machine" from the outside. The TS/JS survey found linearizability
checking absent from every existing implementation — the strongest client-facing assertion in the
ecosystem is a single-leader throw — so this checker is also load-bearing for the project's
differentiation claim.

Two stages couple through one data structure. The stage-9 workload harness records client
operations as they invoke and return; the stage-10 checker consumes that record after the run. If
the format drifts between stages, both must change in lockstep forever. Hence this ADR freezes the
history format now, at stage 5, alongside the checking algorithm and its pre-designed escape hatch.

Constraints inherited from the stack: the checker must be a pure function of the history (identical
seed ⇒ identical verdict and identical failure artifact — the determinism invariant applies to
checkers, not just the cluster); it must run in plain TypeScript in both the Node fuzz tier and,
if ever needed, the playground worker (no native deps, no subprocesses); and it must fit a fuzz
budget where thousands of seeds per minute is the operating regime (PROJECT_LOG spike numbers).

## Decision

**History format (frozen).** The harness emits one entry per client operation:

```ts
interface HistoryEntry {
  opId: string;            // unique per operation
  clientId: number;
  kind: 'read' | 'write';
  key: string;
  val?: string;            // written value, or value a read returned
  invokeG: number;         // virtual time of invocation
  returnG?: number;        // virtual time of return; absent if never returned
  outcome: 'ok' | 'fail' | 'indeterminate';
}
```

Semantics: `ok` means the client received a definitive success — the operation took effect and its
interval is `[invokeG, returnG]`. `fail` means a definitive rejection: the harness maps a
`clientResult` of `notLeader` to `fail` (core's `clientResult` results are `ok | notLeader |
unknown`) — the op never entered the log, so the checker treats it as never linearized and
excludes it from the search. `indeterminate`
(client timeout, or a `clientResult` of `unknown` across a leader change) gets an **open return
interval**: the checker may linearize it at any point after `invokeG`, or never. This is the
standard treatment (Knossos/porcupine `:info` ops) and it is what makes crash-adjacent histories
checkable at all: a write that timed out may have committed anyway, and both worlds must be
explored. All write values are unique by construction — the harness writes `clientId:seq` — so
every read names exactly one dictating write.

**Checker: per-key Wing & Gong with Lowe-style memoization, end of run.** Linearizability is
compositional (Herlihy & Wing): a history over multiple keys is linearizable iff its per-key
projections are. The checker partitions the history by key and runs an independent search per key
against a single-register model (state = last linearized write's value, initially null). The search
is Wing & Gong's: repeatedly pick a minimal operation (one whose interval is not preceded by any
other pending op's return), apply it to the model, recurse; backtrack on read mismatch. Memoization
follows Lowe: the search state is `(bitmask of linearized ops, register value)`, and with unique
writes the value component is fully determined by the last linearized write, so the memo set stays
small and revisited configurations are pruned in O(1).

Tractable by construction, not by hope: the stage-9 workload is ~3 clients × 40 ops over 5 keys —
about 120 operations, ≤ ~35 per key after skew. Concurrency is bounded by client count (≤ 3
overlapping intervals plus open indeterminate ops), which is what actually bounds the branch factor;
the exponential worst case of WGL needs adversarial concurrency the workload cannot produce.
Budget: **1–10 ms per key per run**, measured, with the fuzz tier's per-run timeout as the
backstop. The check runs once, at end of run, after the liveness phase — not per tick.

**Pre-designed fallback, wired only if profiling demands.** This documents the gray-area policy
explicitly: when a checker threatens the budget, the invariant is never silently weakened — the
escape hatch is designed up front, and switching to it is a visible, one-line dispatch change, not
a quiet relaxation. Tier (a): an O(n log n) real-time-order check on **all** seeds, exploiting
unique writes — map each read to its dictating write, then verify interval-order constraints with
a single sweep over invoke/return endpoints (the Gibbons–Korach construction for registers with
unique values). Tier (a) is sound but can be inconclusive on histories with open-interval
indeterminate ops. Tier (b): full memoized WGL on exactly the seeds where (a) is inconclusive,
plus the nightly campaign tier, where wall-clock budget is ample. Both tiers consume the identical
frozen history format; the dispatch is one line in the checker entry point.

**On violation:** the checker raises the same `InvariantViolation` that the per-tick oracles
raise, feeding the identical minimizer → failure-JSON flow of ADR-0003 (the frozen
`{scenario, violation, minimizedScenario, traceTail}` shape per ADR-0003/0005). Its `eventSeq`
is the final trace seq of the run — the checker runs end-of-run, and localization is the
minimizer's job. The checker sorts operations by `(invokeG, opId)` before searching, so
the search order — and therefore the specific counterexample reported — is itself deterministic.

## Options Considered

### Option A — port or wrap an existing checker (porcupine, Knossos)

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Low (wrap) / High (port) | Proven fast (porcupine) | Broken by subprocess boundary | Foreign codebase or FFI seam |

Pros: porcupine (Go) and Knossos (Clojure) are battle-tested by Jepsen-adjacent use; their
algorithms (P-compositionality, WGL + memoization) are exactly the right ones; zero algorithm risk.

Cons: both are unusable client-side — no Go or Clojure runtime ships in a browser worker, so the
playground could never run the checker even optionally. Wrapping means a subprocess plus JSON
marshaling in the Node tier, adding a runtime dependency, a version seam, and a nondeterministic
boundary (process spawn, environment) to a stack whose whole premise is one deterministic process.
Porting porcupine to TypeScript is not actually an alternative: it *is* option C with the added
constraint of tracking someone else's API shape.

### Option B — sequential-consistency-only checking

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Low | O(n log n) | Pure function, fine | Small, but claim is wrong |

Pros: cheap; simple; per-client order plus write uniqueness makes it nearly trivial; never blows
the budget on any workload size.

Cons: checks the wrong theorem. Sequential consistency drops the real-time constraint, so a stale
read served by a deposed leader — returning a value overwritten seconds ago — passes, and that is
precisely the §8 bug class the log-routed-reads design exists to be checked against. Raft's claim
to clients is linearizability; a checker that verifies less converts "the tests are the product"
into an overclaim. Rejected as the primary checker. (Its spirit survives as tier (a) of the
fallback, which *keeps* the real-time constraint and degrades to "inconclusive" rather than to a
weaker property.)

### Option C — custom per-key WGL + memoization, two-tier fallback documented (chosen)

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Moderate (~200 lines) | 1–10 ms/key at ratified workload | Pure function of history | Owned, testable against known histories |

Pros: runs everywhere the sim runs (Node, worker, browser) with zero dependencies; exactly the
algorithm the proven tools use, sized to a workload chosen to keep it tractable; the frozen format
plus compositionality means workload growth is absorbed by adding keys before it forces the
fallback; the fallback is designed, budgeted, and dispatch-ready rather than improvised under
pressure.

Cons: a hand-rolled checker can itself be wrong — a false-pass checker is worse than none. Mitigated
by testing the checker against hand-built histories with known verdicts (including the classic
non-linearizable-but-sequentially-consistent cases) and by cross-checking a sample of histories
against porcupine offline, once, during stage 10 development. Exponential worst case exists in
principle; bounded in practice by client count and by the per-run timeout that turns a pathological
seed into a reported anomaly rather than a hung campaign.

## Trade-off Analysis

The decision trades algorithm-reuse safety (option A) for stack coherence: one language, one
process, one deterministic verdict, checker code reviewable in the same PR discipline as the
protocol core. The risk that matters — checker correctness — is not actually mitigated by wrapping
a foreign binary, because the marshaling seam and outcome mapping are where wrapping bugs live;
it is mitigated by known-verdict tests, which option C needs anyway.

Against option B the trade is compute for claim strength, and the compute is bounded by
construction: compositionality caps the search at ~35 ops/key, client count caps concurrency, and
unique writes collapse the memo state. The workload shape is thus part of the checking design, not
an accident — growing the workload means growing keys and clients together, deliberately.

The two-tier fallback resolves the classic tension between "never weaken invariants" and "never
blow the budget" by refusing to choose at runtime: every seed always gets at least the sound
real-time check, full WGL runs wherever (a) is inconclusive, and the nightly tier runs full WGL
regardless — so no seed's verdict is ever silently downgraded, and the switch itself is a diff.

## Consequences

**Easier.** Stage 9 and stage 10 can build against a frozen interface in parallel. The failure
pipeline is uniform: a linearizability violation minimizes and reports exactly like an Election
Safety violation (ADR-0003). The playground could, later, run the same checker in the worker with
zero porting. Adding keys or clients to the workload needs no checker change. The bug log gains
the strongest possible entry class: "clients observed a non-linearizable history, seed N".

**Harder.** The frozen format means extending operation kinds (e.g. CAS, range reads) is additive
on `kind` but requires extending the register model and the tier-(a) mapping — a real cost, so new
kinds should arrive with their model, not before. The ≤ ~35-ops-per-key bitmask exceeds 32 bits,
and JS bitwise operators truncate at 32, so the memo key must be encoded as BigInt or a two-word
string — a small tax stage 10 must not discover by silent overflow. End-of-run checking means a
violating run reports after completion, not at the violating tick; the minimizer, not the checker,
localizes.

**Note (ux.md alignment).** No contradiction found with the stage-4 data contract: the checker is
end-of-run and the playground contract is a streaming frame protocol, so they do not intersect
today. One gap worth recording: ux.md's palette assigns `--fault` to "violations" but neither
`ClusterView` nor the `eventLogDelta` shape declares a violation channel; if stage 12 wants to
surface checker or per-tick oracle violations in the UI, they should ride as an `eventLogDelta`
with a dedicated `kind` — an additive change to the contract, decided at stage 12, not here.

**Revisit when:** (1) profiling shows any key exceeding the 10 ms budget at the ratified workload —
wire the tier dispatch; (2) the deferred client retry / duplicate-detection milestone (research.md
§8) lands — retried commands must keep one `opId` and the `indeterminate` semantics must be
re-derived against session semantics, since a retry that double-applies would otherwise surface as
a checker verdict about the harness rather than the cluster; (3) the workload grows beyond ~50
ops/key or ~6 concurrent clients — re-measure before trusting the budget, since concurrency, not
op count, drives the search.
