# ADR-0002: Simulator scheduler and fault-injection API

**Status:** Accepted / **Date:** 2026-08-29 / **Deciders:** Suvra Samajder

## Context

`packages/sim` owns every source of nondeterminism that `packages/core` is forbidden to touch
(`Date.now`, `Math.random`, timers — lint-banned in both packages). The stack-wide invariant: an
identical seed produces a byte-identical event trace, verified by a double-run CI job. One
simulator module serves two consumers with no porting — the Node fuzz campaign at virtual-time
speed, and the playground worker (`apps/playground`), whose ratified contract in `docs/ux.md`
requires `scrubTo(g)` to re-render any instant deterministically, `inject(faultOp)` to stamp and
append faults to a live script, and a share URL reproducing exactly what the visitor sees.

The bar for the fault repertoire comes from `docs/research.md`: Antithesis broke four
production-hardened Raft implementations with network turbulence alone, and the trap catalog
(Figure 8, stale replies, truncation on duplicates, timer-reset livelock) is reachable only through
reordering, duplication, partitions, crashes, and skewed relative timings. This ADR fixes the
scheduler that orders those events, the PRNG that draws them, and the API that scripts them. The
decisions are ratified; this document records why the alternatives lost.

## Decision

**Scheduler.** A binary min-heap ordered by the composite key `(dueAtGlobal, seq)`, where `seq` is
a monotone insertion counter. The composite key is a total order, so tie-breaks are deterministic
by construction and the pop sequence is identical regardless of sift implementation details.
Virtual time is integer milliseconds only; floats are banned from all time arithmetic.

**PRNG.** xoshiro128\*\* — four 32-bit words of state, `Math.imul` and unsigned shifts, no BigInt —
seeded via splitmix32 from the master seed. Four independent streams are split off the master:
`netRng`, `timerRng`, `faultRng`, `workloadRng`. The split exists for the minimizer: deleting a
fault or workload op must not perturb network-delay draws, or shrunk counterexamples stop
reproducing.

**Fault model.** One declarative, serializable
`Scenario {v, seed, nodes, horizonMs, net: {delayMs: [min,max], dropRate, dupRate}, script:
FaultOp[], workload?: {clients, opsPerClient, keys}, ops?: WorkloadOp[]}`. Exactly one of
`workload` and `ops` is present: `workload` is a generator spec — the sim generates client ops
deterministically from `workloadRng` — and `ops` is an explicit timestamped op list, which the
sim honors when present (the minimizer reifies `workload` into `ops` on its first run against a
failure; ADR-0005). `FaultOp` is a tagged union:
`partition{groups}` | `blockLinks{links}` (directed, asymmetric) | `heal` | `crash{node}` |
`restart{node}` | `clockSkew{node, offsetMs, drift}`. Message reorder is not a separate mechanism —
it falls out of random per-message delay draws. The fuzzer generates scripts from weighted profiles
(partition-heavy, crash-heavy, clock-chaos, mixed) and then reifies them into the Scenario, so a
recorded failure replays bit-for-bit after the generator changes.

**Crash/restart.** Per-node `SimStorage` (hardState + log) lives in the world keyed by `NodeId` and
survives the process object. Crash marks the node down; its timer events are dropped lazily via a
liveness check on pop, and in-flight messages to it are dropped at delivery time — no heap surgery
ever. Restart is `core.init(config, storage.read())`, exercising the real recovery path.

**Clock skew.** Each node sees `localClock(g) = offsetMs + drift * (g - skewStartG) + baseLocal`.
The heap always runs on global time; arming a timer converts a local delay to a global due time via
the inverse mapping. The local↔global mapping is part of the scheduler API from the first commit,
even while every node runs `offset=0, drift=1`, so skew lands later without touching heap keys.

**Persistence.** Synchronous at step granularity. Crash faults land between events, never
mid-effect-list, so `SimStorage` is trivially consistent at every crash point.

## Options Considered

### Scheduler data structure

**A. Sorted array** (binary-search insert + `splice`).

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| trivial | O(n) insert (memmove), O(1) pop | total order trivially stable | trivial |

Pros: simplest possible; insertion-order stability comes free. Cons: O(n) insert is quadratic over
a run; campaigns holding thousands of pending timers and in-flight messages pay a V8 memmove per
enqueue — fine for a demo, wrong for runs measured in simulated cluster-hours.

**B. Binary min-heap over `(dueAtGlobal, seq)` — chosen.**

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| low (~60 lines) | O(log n) insert and pop | total via `seq` tie-break | no dependency, one file |

Pros: logarithmic everywhere; the composite key makes the comparator total, so determinism is
structural, not an accident of sift order; array-backed, so no object identity leaks engine
behavior. Cons: heaps are unstable without `seq` — the tie-break is load-bearing and stays under
the double-run test; no efficient random removal, forcing lazy deletion (wanted anyway for crashes).

**C. Hierarchical calendar queue / timing wheel.**

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| high | amortized O(1) when tuned | bucket order must be pinned; resize is a hazard | resize heuristics, real surface |

Pros: the classic O(1) discrete-event structure for stable delay distributions. Cons: constant
factors depend on bucket-width heuristics tuned to a delay distribution that swarm-tested fault
parameters change per seed; resizing is an extra hiding place for iteration-order nondeterminism;
unjustified before a flame graph shows the heap as a bottleneck.

### PRNG

`Math.random`-derived anything is lint-banned — unseedable and engine-dependent — not an option.

**A. mulberry32.**

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| trivial (one line) | fast | exact | trivial |

Pros: ubiquitous, tiny, trivially auditable. Cons: 32-bit state and a 2^32 period a delay-drawing
campaign exhausts; no principled stream splitting — four streams would be ad hoc correlated reseeds.

**B. PCG32.**

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| medium | poor in JS with BigInt (allocation per draw) | exact | medium (64-bit emulation) |

Pros: excellent statistics; streams are first-class via the increment. Cons: needs 64-bit
multiplies — in JS, BigInt boxing on every draw in the simulator's hottest loop, or hand-rolled
32-bit-pair arithmetic that reintroduces the complexity the choice was meant to avoid.

**C. xoshiro128\*\* seeded by splitmix32 — chosen.**

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| low (~20 lines) | fast, allocation-free | exact; `Math.imul`/`>>>` pin 32-bit semantics | low |

Pros: 128-bit state, 2^128−1 period, strong statistics for its size class; pure 32-bit integer
ops, identical in Node and every browser engine; splitmix32 decorrelates the four state words from
one 32-bit master seed and derives the per-stream seeds, so the four streams are genuinely
independent. Cons: not cryptographic (irrelevant); the xoshiro family's weak low bits are why the
\*\* scrambler is specified; every op must stay unsigned-32 — a discipline, not a difficulty.

### Fault-injection API

**A. Imperative hooks** — test code calls `sim.partition(...)`, `sim.crash(n)` between steps, or
registers callbacks at virtual times.

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| low up-front | n/a | fragile — the schedule lives in imperative code | poor — scenarios are not data |

Pros: no schema to design; maximally flexible; natural for hand-written regression tests. Cons: a
failing run cannot ship as data — replay needs the exact producing code path, a generator refactor
orphans recorded failures, and the share URL would have to serialize behavior instead of a value.

**B. Declarative Scenario + FaultOp script — chosen.**

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| medium (schema + `v` versioning) | n/a | total — one JSON value is the entire input | good — failures replay across generator changes |

Pros: the Scenario is simultaneously the fuzzer's reified output, the regression-corpus entry, the
bug-log attachment, and the playground share-URL payload — one artifact, four consumers. Live
injection is the same mechanism as scripted injection: the worker stamps the current virtual time
onto the FaultOp and appends it to `script`, exactly as `docs/ux.md` specifies for `inject()`.
Reorder-by-delay keeps the schema one op smaller. Cons: every new fault class is a schema change
gated by `v`; expressiveness stops at what the schema encodes — state-conditional faults ("crash
the leader the moment it commits") must become new op types or live in the sim behind `faultRng`.

## Trade-off Analysis

The scheduler choice is pure performance precisely because determinism was made structural first:
with a total order over `(dueAtGlobal, seq)`, any correct priority structure yields the same pop
sequence, so the structure can be swapped later without a trace change — for one integer per
event. Integer-only time kills a bug class of its own: engine-dependent float rounding silently
breaking byte-identical traces between Node and the worker, at the price that clock-skew drift
cannot be a raw float multiplier (see Consequences).

Independent PRNG streams buy minimizer stability with a little seeding ceremony. With one global
stream, deleting FaultOp *k* shifts every later draw, the shrunk scenario explores a different
network schedule, and the bug evaporates mid-shrink; split streams make shrinking a local edit.

Lazy deletion trades bounded dead-event churn for never mutating heap internals — heap surgery is
an O(n) find and a place for ordering bugs — and gets the physics right for free: a message sent
before a crash and delivered after a restart *is* delivered, exactly the stale-message regime the
trap catalog needs.

The declarative script trades expressiveness for replayability — and the project's thesis sits on
replayability: seed-replay and the share URL are the credibility mechanism `docs/research.md` names.

## Consequences

**Easier.**

- Byte-identical traces are cheap to enforce: run the seed twice, diff bytes. The CI self-test and
  the playground `scrubTo(g)` (re-execute from 0 to g) fall out of the same property.
- One serialization is the failure record, the regression corpus, and the share URL; `#v1.<seed>.`
  plus the deflated Scenario (minus the hoisted `v` and `seed`, reassembled on decode) replays
  after generator rewrites because the script is reified data.
- Minimization is tractable: dropping script or workload entries leaves the other streams' draws
  untouched, so shrinking converges instead of chasing a moving schedule.
- Crash and restart are O(1) and structurally safe: no heap surgery, and restart runs the same
  `init(config, storage.read())` path production recovery would.
- Skew ships late without a rewrite: the local↔global mapping has been the API since commit one and
  the heap never sees local time, so enabling skew changes coefficients, not shapes.

**Harder.**

- The `seq` tie-break is load-bearing and invisible. Reordering two enqueue calls in a refactor
  legitimately changes traces (it is a different program), so the double-run test cannot catch a
  regression the author believes is a no-op; a golden-trace corpus over pinned seeds is the guard.
- Lazy deletion lets dead timers of crashed nodes sit in the heap until popped. `horizonMs` bounds
  the growth, but crash-heavy long-horizon profiles should be measured before calling it noise.
- Schema versioning is a public contract: a `v` bump reaches every share URL in the wild;
  `docs/ux.md` already mandates the fail-soft path (toast, then default scenario) — honor it.

**Revisit — genuine tensions found while documenting.**

1. **Drift versus the float ban.** `localClock(g) = offsetMs + drift * (g - skewStartG) +
   baseLocal` with a percentage `drift` is float math in the time domain, and the timer-arming
   inverse divides by it. Holding "integer milliseconds only" requires `drift` stored as an
   integer rate (e.g. parts-per-million) with floor division both ways; floor makes the mapping
   non-injective, so the inverse must be the least global `g` whose local image reaches the due
   time. The ux.md drift slider (±5%) must quantize to that integer form *before* entering the
   Scenario, or a shared URL replays a subtly different run than the one on screen.
2. **Step-granularity persistence versus one named fuzz target.** `docs/research.md` lists
   "responding to an RPC before persisting" as catchable only by killing a node between state
   change and persist acknowledgment. The ratified model — synchronous persistence, crashes only
   between events — makes that window unrepresentable: the trap is enforced by construction
   (core's effect contract orders persist before send), not found by fuzzing. Acceptable now; an
   async-persistence fault stage is the milestone if it should ever be caught, not precluded.
3. **Share-URL shape versus Scenario shape — resolved.** The Scenario serializes verbatim with
   `v` and `seed` hoisted into the plaintext fragment prefix
   (`#v1.<seed>.<base64url(deflate-raw(JSON(scenario minus v and seed)))>`), the decoder
   reassembles both into the Scenario, and ux.md says `horizonMs`, so decode(encode(s))
   round-trips structurally.
