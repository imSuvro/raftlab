# ADR-0001: Sans-IO protocol core interface

**Status:** Accepted / **Date:** 2026-08-29 / **Deciders:** Suvra Samajder

## Context

raftlab's thesis is that the test harness, not the consensus code, is the product. That thesis
imposes one non-negotiable requirement on `packages/core`: an entire cluster must run as a pure
function of (seed, fault schedule), byte-identical across runs, at fuzz-campaign speed in Node and
unmodified in a browser worker. The research phase (docs/research.md) established why every
surveyed TS/JS Raft fails this bar — each couples the protocol to a transport and to wall-clock
timers, so none can simulate a cluster deterministically at all. FoundationDB needed a bespoke
language (Flow) to get single-threaded determinism; JavaScript's event loop already is
single-threaded, so the discipline reduces to a protocol core that performs zero IO and touches
zero ambient nondeterminism — no `Date.now`, no `Math.random`, no timers — enforced by lint.

The core also serves two masters with different performance envelopes. The fuzz campaign in
`packages/sim` executes millions of `step` calls per run and cannot afford accidental quadratic
cost; the playground worker reads node state at ~30Hz to build `ClusterView` frames
(docs/ux.md data contract) and scrubs backward on a timeline, which requires either replay from
zero or cheap state snapshots. Antithesis's Raft study additionally names four implicit paper
assumptions that broken implementations improvise around: atomic per-node event processing, a
framework correlating RPC requests with responses, `currentTerm`/`votedFor` updated atomically
together, and unspecified zones outside the TLA+ spec. The interface below is shaped to make each
of those either structural or impossible to get wrong silently.

## Decision

`packages/core` exposes a sans-IO module with three functions and no classes:

- `init(config, recovered?) -> { state, effects }` — constructs node state, optionally from
  recovered persistent state (`currentTerm`, `votedFor`, `log`), and returns initial effects
  (e.g. the first `resetTimer`).
- `step(state, input) -> Effect[]` — processes exactly one input, **mutating caller-owned state
  in place**, and returns an ordered effect list.
- `cloneState(state) -> state` — deep copy, for checkpoints, checkers, and scrub support.

"Pure" here means: deterministic, zero IO, zero hidden state, zero clock or RNG access. It does
**not** mean persistent data structures. Immutable log copies are O(n²) per run at fuzz scale;
determinism is instead enforced by a CI double-run test asserting byte-identical event-trace
hashes for the same seed (FDB's self-check, research lesson 2).

**Inputs** (one atomic unit of event processing each — Antithesis assumption 1 made structural):

```ts
type Input =
  | { type: 'message'; from: NodeId; msg: Message; now: number }
  | { type: 'timeout'; timer: 'election' | 'heartbeat'; now: number }
  | { type: 'clientRequest'; cmd: Cmd; now: number };
```

`now` is always the node's **local** virtual time, supplied by the environment — which is what
makes the playground's per-node clock-skew slider an environment concern the core never sees.

**Messages**: `RequestVote{term, lastLogIndex, lastLogTerm}`,
`RequestVoteReply{term, granted}`,
`AppendEntries{term, prevLogIndex, prevLogTerm, entries, leaderCommit}`,
`AppendEntriesReply{term, success, matchIndex, conflictIndex}`. On success, `matchIndex` is an
idempotent ack computed by the follower — the leader never derives it from its own current log
length, and no request/response correlation machinery is needed (Antithesis assumption 2, and the
stale-reply trap, both closed by making replies self-describing). On failure, `conflictIndex` is
the fast-backup hint.

**Effects**, an **ordered** list the environment executes in sequence:
`persist{hardState?, appendEntries?, truncateLogFrom?}`, `send{to, msg}`, `resetTimer{timer}`,
`cancelTimer{timer}`, `apply{index, cmd}`, `clientResult{opId, result}`.

**Persistence contract**: the environment must make each `persist` effect durable before acting on
any later effect in the same list and before delivering the node's next input. The core orders
effects so the paper's rules fall out mechanically: the vote is persisted before the reply `send`;
a follower's append is persisted before its ack; the leader self-acks via its own persist.
`hardState` carries `currentTerm` and `votedFor` together, atomically (Antithesis assumption 3).

**Timers**: the core emits `resetTimer` as intent only. The environment draws election jitter
from its seeded PRNG within `config.electionTimeoutMs = [min, max]` and later feeds a `timeout`
input. The core holds no randomness whatsoever — the paper's only nondeterminism (§5.6 randomized
timeouts) lives entirely in the seeded environment.

**Clients**: writes append `{term, cmd}` with a unique `opId`; `clientResult` fires ok at
commit+apply; on step-down or term mismatch the result is `'unknown'` (indeterminate — the entry
may still commit later; never reported as failure). Reads go through the log, which is provably
linearizable by the same mechanism as writes; ReadIndex and leases are deferred. A no-op entry is
appended on election win (§5.4.2/§8) so the new leader learns the commit frontier.

**Conventions**: `NodeId` is a number in `0..n-1`. Log indices are 1-based and implicit from
array position (`log[i]` has index `i+1`); no per-entry index field to drift out of sync.

## Options Considered

### Option A — OO class with injected clock/network/storage interfaces

The FDB shape transplanted to TS: `new RaftNode(id, config, clock, network, storage)`, where the
sim injects `SimClock`/`SimNetwork`/`SimStorage` and production injects real ones.

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Medium — four interfaces plus two implementations each | Good — mutation internal | By discipline only; every injected impl is a leak surface | Medium — protocol logic interleaved with call-outs |

Pros: reads like Figure 2's prose ("send RequestVote to all servers" is a literal method call);
no effect-ordering contract to document because side effects execute at the point of decision;
familiar to any reviewer.

Cons: hidden state accretes in the class and inside injected impls, so "what happened this step"
is not a value — trace capture requires instrumenting every interface, and the double-run hash
test has nothing canonical to hash. Persistence-before-reply becomes a temporal coupling between
two call-outs inside one method rather than an ordering visible in a returned list; the exact
crash window the fuzzer must test (kill between state change and persist ack) hides inside a
method body. Snapshots for scrubbing require every impl to be cloneable. This is structurally the
architecture all five surveyed implementations have, and the reason none of them can simulate.

### Option B — Fully immutable reducer: `(state, event) -> (state', effects)`

Redux-style: every step returns a fresh state value; the old one remains valid.

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Low — pure functions, trivial tests | Poor at fuzz scale — naive copies are O(n²) per run over log length | Strong by construction | Good, until structural sharing enters |

Pros: referential transparency; snapshots and time-travel are free (keep old references);
checkers can hold any historical state without copying; no aliasing bugs possible.

Cons: a log of L entries appended one at a time costs Σ O(L) = O(L²) copying per node per run —
at millions of fuzz steps this is the campaign's whole budget. Escaping it requires structural
sharing: either a persistent-collections dependency (foreign to a zero-dependency core, and its
internals must themselves be deterministic across engines) or hand-rolled sharing, which
reintroduces aliasing subtleties worse than disciplined mutation because they hide behind an
immutability claim. GC pressure at campaign scale is real; and the trace-hash test walks the
state anyway, so construction-time immutability buys less verification than it appears to.

### Option C (chosen) — Mutate-in-place step module with explicit `cloneState`

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Low–Medium — three functions, one ordering contract | Best — O(1) amortized append, zero copies on the hot path | Verified, not constructed: lint bans ambient sources; CI double-run asserts trace-hash equality | Medium — aliasing discipline at the effect boundary |

Pros: the hot path allocates nothing it does not keep; effects as a returned ordered list make
persistence windows, message sends, and timer intents first-class values the simulator can delay,
drop, duplicate, or crash between — the entire fault repertoire operates on data. `cloneState`
makes snapshot cost explicit and chosen (checkpoint cadence is a sim policy, not a core tax).
The module shape (no `this`) leaves nowhere for hidden state to live.

Cons: determinism is a theorem about the code plus a lint rule plus a CI test, not a property the
type system grants. Callers must not alias into state across steps; effect payloads (notably
`entries` in `send`) must be treated as immutable by convention or defensively copied, or a later
in-place truncation mutates an in-flight message. `===` identity is useless for change detection.

## Trade-off Analysis

The real axis is *determinism by construction* (B) versus *determinism by verification* (C), with
A offering neither cleanly. B's construction guarantee is worth little here because the project
already requires the double-run trace-hash test for other reasons — the sim's scheduler, PRNG
streams, and checkers must also be deterministic, and only an end-to-end hash catches a regression
in any of them. Once that test exists, C's verification is equivalent in practice and strictly
cheaper at runtime: the O(n²) copying B imposes is paid on every one of millions of fuzz steps,
while C's aliasing risk is paid once, at the effect boundary, under review and under the same
hash test that would expose a violation as a trace divergence.

A is rejected on testability, not taste: effects-as-return-values is what lets the scheduler kill
a node between "state changed" and "persist acknowledged" — the double-vote trap requires exactly
that window, and in A the window is a private interleaving inside a method. (Note: the ratified
synchronous per-step persistence — ADR-0002, Revisit — makes that exact window unrepresentable
until an async-persistence fault stage exists.) The effect list also
gives the playground its event stream for free; A would need parallel instrumentation.

Two deliberate deviations from the paper's minimalism are recorded here. `conflictIndex` is
included although the paper doubts fast backoff is necessary (§5.3 scope guidance) — it is one field on a reply the
follower computes anyway, and campaign throughput benefits when partitions heal against long
divergent logs. `matchIndex`-in-reply deviates from the paper's leader-side
`prevLogIndex + len(entries)` bookkeeping; it is the same value computed where the information
lives, and it removes the stale-reply/wrong-formula trap class entirely.

## Consequences

**Easier.** The sim executes effects against its own network/storage/timer models with no
interface seams; every fault is an operation on data in flight. The double-run determinism test
hashes the effect stream directly. The playground worker reads caller-owned state to build
`ClusterView` frames — every field the ux.md contract needs (`role`, `term`, `votedFor`,
`commitIndex`, `lastApplied`, log tail) is plain data on the state object, and the four `inflight`
message kinds in ux.md match this message set one-to-one. `postMessage` structured-clone gives the
UI an implicit snapshot, so in-place mutation never leaks across the worker boundary. Recovery
testing is `init(config, recovered)` with whatever the sim's storage model retained.

**Harder.** Aliasing discipline is on the review checklist forever: effect payloads referencing
live state arrays are the one bug class this design invites, and the trace-hash test catches it
only when a schedule happens to expose it. Timeline scrubbing cannot step backward; the worker
must replay from `init` or from `cloneState` checkpoints, and checkpoint cadence becomes a tuning
knob the playground owns. Checkers wanting historical state must pay for clones explicitly. React
memoization cannot use identity; frames must be fresh values (they are, via structured clone).

**Revisit.** ReadIndex/leases when log-routed reads become the demo's visible bottleneck;
duplicate detection (client session cache, §8) at the same milestone; membership changes and
snapshotting will extend both the message set and the `persist` effect and get their own ADRs.
If profiling shows checkpoint clones dominating scrub latency, revisit structural sharing *for
the log only*, keeping the rest of state mutable. One cosmetic mismatch, not a contradiction:
ux.md's wireframe labels nodes N1–N5 while `NodeId` is 0-based; the playground maps
`id -> N{id+1}` at render time, and share-URL scenarios carry raw 0-based ids.
