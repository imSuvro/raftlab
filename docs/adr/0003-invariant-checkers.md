# ADR-0003: Invariant checker architecture

**Status:** Accepted / **Date:** 2026-08-29 / **Deciders:** Suvra Samajder

## Context

raftlab's differentiation is the harness, not the Raft (docs/research.md): Antithesis found
safety violations in four mature, production-hardened Raft implementations within an hour using
network turbulence alone. The checkers are the oracle that turns a fuzz run into a verdict — the
five Figure 3 safety properties (Election Safety, Leader Append-Only, Log Matching, Leader
Completeness, State Machine Safety) are all directly executable over global simulator state, and
the paper's proof chain means State Machine Safety is the end-to-end oracle while the others
localize the diagnosis when it trips.

The simulator (packages/sim) executes a discrete-event loop ordered by (dueAtGlobal, seq); each
step consumes one event and yields core's effects (persist, send, resetTimer, cancelTimer, apply,
clientResult); role transitions and commitIndex advances are not effects and must be derived by
comparing worldView state across steps. The checkers sit on the hot path of every event, and the
spike numbers set the budget: ~17.4M events/sec bare, ~3.9M with naive per-event tracing, and a
fuzz-tier target of ≥3,000 seeds/min. Per-event checker cost must be constant-factor, not
asymptotic. Two further constraints: the stack-wide determinism invariant (identical seed implies
byte-identical event trace) means checkers must be pure observers, and the playground worker
replays entire runs synchronously on every timeline scrub (~1.0 ms per 18k events measured), so
anything running there must be near-free. TigerBeetle's StateChecker — a simulator-owned
canonical committed history checked per step, catching split-brain at the exact divergent op —
is the adopted prior art (research.md, design lesson 4).

## Decision

The sim hands `(worldView, event, effects)` to a `CheckerSet` after **every** step. Checkers are
read-only observers: they never mutate `worldView`, never draw from any PRNG stream, and never
enqueue events, so enabling or disabling them cannot perturb the trace. Each property is checked
incrementally against global bookkeeping, O(1) amortized per event:

- **Election Safety** — global `Map<term, NodeId>`; whenever the across-step worldView
  comparison shows a node newly in the leader role, assert the term's entry is absent or already
  this node, then record it.
- **Log Matching** — global `Map<"index:term" -> entryHash>`; every append effect asserts each
  appended (index, term) is new-or-matching **and** that the predecessor entry (index-1, its
  term) matches the map, so a matching pair certifies a matching prefix inductively. A full
  O(total log) cross-node scan runs at end-of-run in every tier, and additionally every 1,000
  events under `--paranoid` (the nightly tier).
- **Leader Completeness** — the CheckerSet owns the canonical committed prefix (the StateChecker
  pattern). It grows monotonically whenever the across-step worldView comparison shows a node's
  commitIndex advance, asserting prefix-consistency while growing; on every election win observed
  the same way, assert the new leader's log contains the entire committed prefix. O(committed)
  per election, acceptable because elections are rare relative to events.
- **State Machine Safety** — global applied `Map<index -> entryHash>`; every apply effect
  asserts hash equality at that index (with per-node in-order apply as a side condition).
- **Leader Append-Only** — checked per-leader: while a node holds leadership, its log effects
  must be strict appends — no in-place term or index rewrites, no truncation.

On violation the checker throws `InvariantViolation{name, detail, eventSeq}`. The fuzz CLI
catches it, runs the minimizer, and writes `failure-<seed>.json` containing
`{scenario, violation, minimizedScenario, traceTail}` (the last 200 trace records), then prints
the repro command `pnpm repro failure-<seed>.json` — which re-runs the scenario and asserts the
**same** violation name and trace hash at the commit that produced the artifact, so a repro that
fails to reproduce is itself a failure.

Checkers live in `packages/sim/src/checkers/` and run in three places: the fuzz campaign, the
regression suite (replaying the minimized scenarios committed under
`packages/sim/test/regressions/*.json`), and — a cheap subset (Election Safety,
State Machine Safety) — in the playground worker behind a dev flag.

## Options Considered

### Option A — end-of-run checking only

| Axis | Assessment |
|---|---|
| Complexity | Low — one pass over final global state, no bookkeeping |
| Performance | Best: zero hot-path cost; one O(nodes × log) pass per run |
| Determinism | Unaffected — observer at a single point |
| Maintenance | Low in code; high in human debugging cost |

Pros: near-zero per-event cost; trivially correct (there is no incremental state to desync);
the checker is a direct transcription of Figure 3 over final state.

Cons: a violation reports "the run ended bad", not the event that broke it — `eventSeq` is
lost, `traceTail` degenerates to "the whole run", and the minimizer's fitness function collapses
to a boolean over complete runs, so convergence is slow and fingerprints are coarse: two
distinct bugs that both end in divergent logs are indistinguishable, and delta-debugging steps
that transiently mask one bug while exposing another are silently accepted. Transient violations
that self-mask (an illegal truncation later overwritten by a legitimate one) are invisible.
Leader Append-Only is unverifiable at end-of-run at all — the final log of a misbehaving leader
can be indistinguishable from a correct one.

### Option B — full-state scan after every event

| Axis | Assessment |
|---|---|
| Complexity | Low-medium — stateless scans, no incremental model |
| Performance | O(nodes × total log) per event — unaffordable at fuzz scale |
| Determinism | Unaffected |
| Maintenance | Low — stateless checkers cannot drift out of sync |

Pros: catches every violation at the exact event with zero bookkeeping risk; maximum soundness.

Cons: with 5 nodes and logs of a few thousand entries the scan multiplies per-event cost by
~10^4; the spike's millions of events/sec collapse to thousands, the ≥3,000 seeds/min fuzz tier
is unreachable, and campaign coverage — the product's core claim — shrinks by the same factor.
Also unusable in the playground worker, where scrubbing replays runs synchronously on the UI's
critical path.

### Option C — incremental per-event checks + periodic/final full scans (chosen)

| Axis | Assessment |
|---|---|
| Complexity | Medium — global maps must track effects exactly |
| Performance | O(1) amortized per event; O(total log) at run end and per 1,000 events (nightly) |
| Determinism | Unaffected — pure observers, no PRNG, no mutation |
| Maintenance | Medium — every new effect kind must be routed to the checkers |

Pros: exact `eventSeq` at violation time, so the minimizer preserves "the same bug" and the
repro contract can demand identical violation + trace hash; hot-path cost is a handful of Map
operations; the end-of-run scan backstops incremental-bookkeeping bugs; `--paranoid` narrows the
detection gap to 1,000 events at nightly-only cost.

Cons: the bookkeeping is a shadow model that can be wrong — an unsynced map yields silent false
negatives (mitigated by the final scan) or loud false positives; incremental Log Matching only
sees what the effect stream reports, so an omission in the effect taxonomy is a blind spot until
the next full scan.

## Trade-off Analysis

The deciding axis is minimization quality, not raw speed. The minimizer's job is to shrink a
scenario while preserving the *same* bug; that requires a fingerprint. Option C's
`InvariantViolation` carries `name` + `eventSeq`, so `pnpm repro` can assert strict equality of
violation and trace hash — which is what makes `failure-<seed>.json` a trustworthy regression
artifact rather than a flaky one. Option A cannot offer this: distinct root causes share one
end-state fingerprint, and minimization can silently swap bugs mid-shrink.

On performance, the amortized-O(1) claim decomposes: Election Safety is one map probe per role
transition (rare); State Machine Safety one hash compare per apply; Log Matching a few probes
per appended entry — proportional to work the sim already does to execute the append, so
constant-factor overhead, not asymptotic. Leader Completeness's O(committed) on election win is
the one super-constant check, and elections are a vanishing fraction of events in any schedule,
bounded above by the fault-injection rate. Against the spike's headroom (thousands of seeds/min
even at 100x echo-protocol overhead), Option C spends a small constant where Option B spends
four orders of magnitude.

The residual risk of C — shadow-model divergence — is bounded structurally: the end-of-run scan
*is* Option A embedded inside C, so C is never less sound than A over a complete run; and
`--paranoid` is Option B sampled at 1/1,000, so the nightly tier approaches B's per-event
soundness at 0.1% of its cost. Determinism is preserved by construction in all three options,
but C makes it checkable: because checkers never mutate or draw randomness, CI's double-run
trace-hash test passes identically with checkers on or off, and a divergence there indicts the
checker immediately.

## Consequences

**Easier:**

- Regression testing is mechanical: every archived `failure-<seed>.json` replays under
  `pnpm repro` asserting the same violation + trace hash at the commit that produced it, while
  the minimized scenarios committed under `packages/sim/test/regressions/*.json` assert the
  violation only (a legitimate fix changes trace hashes); `docs/bugs.md` rows (seed, minimal
  trace, root cause, fix commit) come straight from these files.
- New oracles slot in without touching the sim loop: `CheckerSet` is a list, so the liveness
  checker (heal-then-converge with bounded tick budget, research design lesson 6) joins later
  as one more member.
- The playground gets protocol-aware checking in the browser for free — the cheap subset costs
  two map operations per relevant effect, negligible against the measured 1 ms full-run replay.

**Harder:**

- The effect taxonomy becomes a load-bearing contract: any new effect kind that touches logs or
  applies must be routed to the checkers, or incremental Log Matching silently under-checks
  until the next full scan. The sim's effect dispatch must be an exhaustive switch over core's
  six effect kinds — persist, send, resetTimer, cancelTimer, apply, clientResult — with no
  default arm, so a new kind is a compile error until routed.
- Soundness is tiered and must be reported honestly: the default fuzz tier can detect a
  transient, self-masking Log Matching violation only at run end; `--paranoid` tightens that to
  a 1,000-event window. Bug-log entries should record which tier caught what.

**Revisit:**

- The `--paranoid` interval (1,000 events) is a guess; tune it against the nightly wall-clock
  budget once the campaign runs.
- If any real violation is ever caught by a periodic/final scan but missed by the incremental
  checks, treat it as a checker bug of the same severity as a protocol bug and close the gap.
- If minimization wall-time becomes the bottleneck, consider checkpointed replay — though the
  spike's ~1 ms full-replay figure suggests it will not be needed.

**Contradiction noted (docs/ux.md):** the ratified worker protocol defines only `frame` and
`scenarioChanged` as worker-to-UI messages — there is no channel for an invariant violation, and
`InvariantViolation` is a throw, which uncaught would kill the playground worker behind the dev
flag. The dev-flag subset must therefore catch and report locally (console, or an additive
`violation` message when stage 12 lands) rather than propagate. Relatedly, `scrubTo(g)` replays
from t=0, so CheckerSet state is rebuilt on every scrub — natural, since the checker lives and
dies with a run, but it means the playground re-verifies the prefix on each scrub; the
cheap-subset restriction is what keeps that affordable. Neither observation changes the design;
both are stage-12 implementation notes.
