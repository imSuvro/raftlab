# Deterministic simulation testing found five bugs in raftlab — none of them in the Raft

A writeup of the methodology, and three bugs walked from seed to root cause.

## The claim I did not want to make

The obvious way to end a project like this is: *"I wrote Raft in TypeScript
and my fuzzer found N bugs in it."* That would have been a better story. What
actually happened is more interesting, and I think more honest about what
deterministic simulation testing (DST) is for.

The protocol core survived 10,000 randomized fault-injection seeds without a
single safety or linearizability violation. The five bugs the campaign found
were in the *verification stack* — the linearizability checker, the trace
minimizer, the CI build graph, the simulator's own clock — plus one
efficiency slip in the core that no invariant would ever have caught.

That is not a failure of the method. It is the method working in an order
nobody advertises: **when your oracle is code, your oracle has bugs, and a
determinism-first pipeline surfaces them first.**

## Methodology

Three properties make everything else possible.

**The core is sans-IO.** The Raft state machine has no clock, no sockets, no
timers, and no randomness. It is `step(state, input) → Effect[]`. It cannot
call `Date.now()` because there is no `Date.now()` in its universe — an ESLint
rule bans the identifier, the member access, and the constructor form across
`packages/core` and `packages/sim`. Randomized election timeouts still exist,
but the core only *declares intent* (`resetTimer('election')`); the
environment draws the jitter from a seeded stream. There is nothing to mock
because there is nothing to inject.

**The simulator owns time.** A binary min-heap ordered by
`(virtualTime, sequenceNumber)` — a total order, so ties break identically
every run. Integer milliseconds only; float time arithmetic is a determinism
landmine waiting for a summation-order change. One master seed splits into
four independent streams (network, timers, faults, workload) via splitmix32,
which matters more than it sounds: it is what lets the minimizer delete a
client operation without perturbing every network delay downstream.

**Determinism is enforced, not assumed.** Every run folds its event stream
into an FNV-1a hash. CI runs scenarios twice and compares. If any
nondeterminism enters the system — an unordered iteration, a stray
`Math.random`, a floating-point drift — a test goes red on the next pull
request. This one test is worth more than any amount of care.

On top of that: five invariant checkers derived from Figure 3 of the paper,
running after *every step*, incrementally, with O(1) amortized bookkeeping;
and a per-key Wing & Gong linearizability checker over client histories.
Every checker is validated by fabricating the violation it exists to catch —
an unchecked checker is just an expensive comment.

The numbers: **~2,600 seeds/minute** with everything armed, four fault
profiles (partition-heavy, crash-heavy, clock-chaos, mixed), 10,000 seeds
clean. CI runs a fixed 500-seed range on every PR — fixed, so a red PR is
reproducible by anyone — and 5,000 rolling seeds nightly.

---

## Bug 1: the oracle overflowed

**Symptom.** The very first run of the fuzz campaign's own smoke test crashed:

```
linearizability: key k2 has 31 ops; raise the bound deliberately
```

Not a violation — a crash, on a perfectly healthy cluster.

**From seed to root cause.** The checker encodes "which operations have been
linearized so far" as a bitmask, and searched it with `1 << i`. JavaScript's
bitwise operators are defined on 32-bit signed integers, so that expression
is sound to exactly 31 bits and then silently wraps. I had written a
defensive bound at 30 operations per key that turned the wraparound into a
loud crash — which is the only reason I found out instead of getting quietly
wrong answers.

But I had sized the bound to *the mask*, not to *the workload*. With three
clients issuing forty operations across five keys, the expected per-key load
is around 24. Seed 7's draw happened to pile 31 onto `k2`.

**Fix.** BigInt masks, memo keys in base 36, bound raised to 60.

**What it cost me to learn.** The distribution your generator actually
produces is not the distribution you designed. If I had set that bound at 64
"to be safe", the checker would have wrapped around at 32 ops and started
returning wrong verdicts — silently declaring histories linearizable that
were not. The loud-failure design, which felt paranoid when I wrote it, is
the only reason this is a footnote rather than an invisible hole in every
result in this repo.

---

## Bug 2: the minimizer returned local minima

**Symptom.** A synthetic bug ("fail whenever node 2 is down") planted in a
seven-fault scenario. The minimizer should have shrunk it to one fault —
crash node 2. It returned three, then two.

**From seed to root cause.** Two effects compounding.

*Context sensitivity.* Whether a fault op is load-bearing depends on the other
shrink dimensions. With sixty client operations still in the scenario,
removing the partition shifted enough PRNG draws to change which node won an
election, which masked the synthetic bug — so the minimizer concluded the
partition was essential. Once the workload ops were removed, that same
partition became pure noise. A single greedy pass over each dimension cannot
see this.

*Knife-edge horizon.* I had ordered the passes with the horizon binary search
first, because it is the cheapest. It shrank the scenario's time bound to
within four milliseconds of the violating event. Every subsequent content
probe then became brittle: removing any operation shifted event timing enough
to push the violation past the end of the surviving window, so the minimizer
read "removing this breaks the repro" when the truth was "removing this moved
the repro four milliseconds later."

**Fix.** Passes iterate to a fixed point, and **time shrinks last**:
ddmin the fault script, ddmin the workload, simplify per-op fields, *then*
binary-search the horizon — repeat until nothing reduces.

**What it cost me to learn.** Minimization over a deterministic simulator is
a search over *coupled* dimensions, not a sequence of independent shrinks.
The failure mode is quiet and expensive: you get a "minimal" repro that
overstates how much machinery the bug requires, and you go debugging a
partition that had nothing to do with it.

---

## Bug 3: no events is not no time

**Symptom.** The playground's first browser run. The UI rendered, five nodes
appeared, the event log stayed empty, and the clock sat at `0.0s` — forever.

**From seed to root cause.** The frame loop asks the world to advance to
`now + 33ms × speed` thirty times a second. `runUntil` drained everything due
in that window and returned. But `scheduler.now` only moves when an event is
*popped* — and the first 150 milliseconds of a run has nothing scheduled at
all, because election timeouts fire at 150–300ms. So the clock stayed at 0,
the next target stayed at 33, and the loop asked for the same empty window
until the heat death of the tab.

**Why 10,000 fuzz seeds never caught it.** The batch API, `run()`, drains
straight to the horizon in a single pass and reads its results from final
state. It never depends on the clock advancing *through* an idle window. The
bug lived exclusively in the incremental API that the playground introduced —
which is to say: **the fuzz campaign validated the simulator I had, not the
simulator I was about to build.**

**Fix.** `runUntil` advances the clock to its limit when nothing is due,
because virtual time genuinely passed. Trace hashes are unaffected — records
carry the popped event's timestamp, not the scheduler's cursor — which the
full test suite confirmed immediately.

**What it cost me to learn.** A discrete-event scheduler that only advances
on event pops is correct for batch runs and silently wrong for anything
driving it in real-time slices. "Nothing happened" and "no time passed" are
different statements, and conflating them is invisible until something asks
the simulator to keep pace with a wall clock.

---

## The one that indicted the test driver

Worth recording because the triage discipline is the actual deliverable.

A 500-run probe of the core reported three liveness failures: *no settled
leader electable in the calm phase*. My first instinct was that I had found a
real bug.

The trace tail said otherwise. The driver was firing election timeouts at a
node that was already a stale-term leader — which the core correctly ignores,
because Figure 2 scopes election timeouts to followers and candidates.
Meanwhile a partitioned node held a higher term from elections that had been
dropped. In a real deployment, progress comes from that leader's *heartbeats*
being rejected by the higher-term node, which deposes it. My driver never
drove heartbeats while hunting for a leader.

Driver fixed: 500/500 clean, 601k steps, 9,059 elections, 12,048 restarts,
159,477 commits.

The lesson generalizes: in DST, the first suspect for a violation is the
newest code, and the newest code is usually the harness. The triage was cheap
only because the run replayed identically every time I looked at it.

---

## What I would tell someone starting this

**Build the determinism test before the protocol.** Run every scenario twice,
hash the traces, compare. It is twenty lines and it is the foundation
everything else stands on.

**Ban the clock at the lint level.** Not in a code review checklist — in CI.
`Date.now`, `Math.random`, `setTimeout`, `new Date()`. Three ESLint rule
families, because each catches a syntactic form the others miss.

**Make your oracle fail loudly at its limits.** Every checker has a domain
where it stops being valid. Assert that boundary and crash at it. A checker
that silently degrades is worse than no checker, because it produces green
runs you will cite as evidence.

**Split your PRNG streams.** One seed, several independent streams, one per
concern. It costs nothing and it is what makes minimization converge.

**Reify what you generate.** A failing case should replay from a
self-contained scenario file, not from "seed 8472 plus whatever the generator
happened to be that week." Generator code changes; archived bugs should not
evaporate when it does.

And the one that surprised me: **budget for the harness having bugs.** I
spent more debugging time on checkers, minimizers, and schedulers than on
Raft itself. That is not a detour from the work — at the scale where DST pays
off, it *is* the work.
