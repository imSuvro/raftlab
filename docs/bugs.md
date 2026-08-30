# Bug log

Every bug found while building and fuzzing raftlab, with its seed or
reproducing test, minimized trace, root cause, and fix commit. This log is
deliberately complete: it includes bugs the harness found in the *checkers
and tooling themselves* — in deterministic simulation testing the oracle is
code too, and its bugs are part of the honest record. One entry is a
not-a-bug: a violation report that turned out to indict the test driver,
kept here because the triage discipline is the point.

## Campaign status

| Sweep | Seeds | Profiles | Checkers | Result |
|---|---|---|---|---|
| Local campaign (stage 11) | 5,000 (0:1250 × 4) | mixed, partition-heavy, crash-heavy, clock-chaos | invariants + linearizability | **0 violations**, 112s, ~2,676 seeds/min |
| Paranoid sweep (stage 11) | 5,000 (1250:2500 × 4) | all | + full log-matching scan every 1,000 events | **0 violations**, 126s, ~2,387 seeds/min |
| CI fuzz-smoke | fixed 500 (0:500 mixed) | mixed | invariants + linearizability | every PR |
| Nightly | 5,000/night, rolling base seed | 4 shards × profiles | + --paranoid | cron 01:30 UTC |

The protocol core reached the fuzz campaign after unusually heavy stage-8
verification (70 curated tests from the paper's figures, three adversarial
audit lenses, and a 500-run randomized probe with safety ledgers — 601k
steps). The campaign then found no core safety or linearizability violation
in 10,000 seeds. The bugs it *did* find were in the verification stack —
which is exactly where a determinism-first pipeline surfaces them first.

---

## BUG-1 — Linearizability checker: 32-bit mask overflow at 31 ops/key

- **Found by**: the fuzz campaign's generator spot-check
  (`fuzz.test.ts` — `generateScenario(7, 'mixed')`), first run.
- **Symptom**: checker crashed with
  `linearizability: key k2 has 31 ops; raise the bound deliberately`
  on a perfectly healthy run.
- **Minimized repro**: any scenario whose workload lands 31+ completed ops
  on one key — with `{clients: 3, opsPerClient: 40, keys: 5}` the expected
  per-key load is ~24, and seed 7's draw pushed one key to 31.
- **Root cause**: the Wing&Gong search encoded the linearized-op set as a
  JavaScript number bitmask (`1 << i`), which is only sound to 31 bits. The
  defensive bound at 30 ops turned a silent-wraparound hazard into a loud
  crash — correctly — but the bound itself was sized to the mask, not to
  the workload the generator actually produces.
- **Fix**: bigint masks (`1n << BigInt(i)`), memo key `mask.toString(36)`,
  defensive bound raised to 60. Fixed in the stage-11 branch before merge
  (see `feat(sim): fuzz campaign` commit).
- **Lesson**: the oracle's own limits must be tested against the generator's
  actual distribution, not its intended one. The loud-failure design
  (`never weaken invariants` — fail the run rather than skip the key,
  ADR-0004) is what made this visible instead of silently unchecked.

## BUG-2 — Minimizer: greedy pass order left non-minimal repros

- **Found by**: the stage-11 synthetic-bug test (`fuzz.test.ts`,
  deterministic sabotage: "fail while node 2 is down"), which demanded a
  1-op shrink and got 2–3 ops.
- **Symptom**: `minimizeScenario` reported a "minimized" script still
  containing a partition op that a manual probe proved removable.
- **Root cause**: two interacting effects. (1) *Context sensitivity*:
  whether a fault op is load-bearing depends on the other shrink dimensions
  — with 60 workload ops present, removing the partition shifted PRNG draws
  enough to change the elected leader and mask the synthetic bug; after the
  ops were removed it became pure noise. A single greedy sequence of passes
  cannot see this. (2) *Knife-edge horizon*: shrinking `horizonMs` first,
  to within ~4ms of the violation, made every later content probe brittle —
  removing any op shifted event timing out of the surviving window.
- **Fix**: passes iterate to a fixed point, and time shrinks **last**
  (ddmin script → ddmin ops → field simplification → horizon, repeated
  until no pass reduces). Fixed in the stage-11 branch before merge.
- **Lesson**: minimization over a deterministic simulator is itself a
  search over coupled dimensions; "shrink each dimension once, in order"
  quietly returns local minima that overstate how essential the surviving
  ops are.

## BUG-3 — Core: stale failure reply regressed nextIndex below matchIndex

- **Found by**: stage-8 adversarial audit (Students'-Guide-traps lens),
  probe P5; locked in by `adversarial.test.ts` ("the named floor case").
- **Repro**: leader term 1, log `[noop@1, w1@2]`; peer 1 acks
  `matchIndex=2` (nextIndex→3); a delayed duplicate of an *earlier* failure
  reply `{success:false, conflictIndex:1}` then arrives: nextIndex(1)
  dropped 3→1 and the leader re-shipped its entire log from prev=0.
- **Severity**: efficiency, not safety — matchIndex and commitIndex were
  untouched and the state re-converged on the next ack. No invariant fires;
  a bandwidth regression under message duplication.
- **Root cause**: the backup path treated every failure reply as fresh
  evidence, ignoring the already-proven replication floor.
- **Fix**: `nextIndex` backup floored at `matchIndex+1` (everything through
  matchIndex is proven replicated). Commit `d3f8e4e` (stage 8).

## NOT-A-BUG — "3 of 500 calm-phase failures" that indicted the driver

- **Report**: a 500-run randomized probe of the stage-8 core reported 3
  runs failing `LIVENESS: no settled leader electable in calm phase`.
- **Triage**: the trace tail showed the probe's calm-phase driver firing
  election timeouts at a node that was *already a stale-term leader* —
  which the core correctly ignores (leaders do not run elections;
  Figure 2 scopes election timeouts to followers/candidates). Meanwhile a
  partitioned node held a higher term from dropped elections. A real
  environment progresses through the leader's heartbeats being *rejected*
  by the higher-term node, deposing it; the driver never drove heartbeats
  while hunting for a leader.
- **Resolution**: driver fixed to drive the deposition path;
  **500/500 clean** (601k steps, 9,059 elections, 12k restarts, 159k
  commits). The protocol was exonerated by its own trace.
- **Lesson**: in DST the first suspect for a violation is the newest code —
  which is usually the harness, not the protocol. The triage is only cheap
  because the run replays deterministically.

---

## Paper-misreading check

Per the project's gray-area rule, any bug tracing to a misreading of the
Raft paper must be flagged prominently here and adjacent logic re-verified.
**None of the bugs above trace to a paper misreading**: BUG-3 is an
optimization-layer slip the paper doesn't legislate, and BUG-1/BUG-2 live
in the verification stack. The Figure-2 rule set, the §5.4.2 commit
restriction, and the §8 no-op behavior all survived three audit lenses,
10,000 fuzz seeds, and the paper-scenario suite unchanged.

## BUG-4 — CI: fuzz jobs ran before the workspace was built

- **Found by**: the `fuzz-smoke` job's first run on PR #4 — it failed in
  19s while the identical 500-seed range passed locally.
- **Symptom**: `ERR_MODULE_NOT_FOUND: Cannot find module
  packages/sim/node_modules/@raftlab/core/dist/index.js imported from
  packages/sim/src/engine/world.ts`.
- **Root cause**: the fuzz CLI runs TypeScript source through `tsx`, but
  its *cross-package* import of `@raftlab/core` resolves through the
  workspace link to that package's `dist/` — which the fuzz jobs never
  built. It passed locally only because the working tree happened to carry
  a `dist/` from an earlier `pnpm build`.
- **Second-order finding during triage**: reproducing it locally by
  deleting `dist/` did *not* reproduce — `tsc -b` saw a fresh
  `tsconfig.tsbuildinfo` and silently skipped emitting. Deleting the
  buildinfo restored the emit. Fresh CI checkouts carry no buildinfo, so
  the workflow fix is sufficient, but it is a sharp edge for anyone
  hand-cleaning `dist/` locally: remove `*.tsbuildinfo` too.
- **Fix**: `pnpm build` added ahead of the fuzz step in `ci.yml` and
  `nightly.yml`. Commit `e4ba4db`.
- **Lesson**: a green local run of the *same seeds* is not evidence the CI
  job works — the deterministic guarantee covers the simulation, not the
  build graph around it. This is the one class of failure seed-reproducibility
  cannot help with, which is why the smoke job runs on a clean checkout.

## BUG-5 — Simulator: virtual time froze across idle windows

- **Found by**: the playground's first browser run (stage 12) — the UI
  rendered, the cluster appeared, and the clock sat at `0.0s` forever.
- **Root cause**: the frame loop asks the world to advance to
  `now + 33ms × speed`. `runUntil` drained every event due in that window
  and returned — but `sched.now` only moves when an event is *popped*, and
  the first 150ms of a run has nothing scheduled (election timeouts fire at
  150–300ms). So `now` stayed 0, the next target stayed 33, and the loop
  asked for the same empty window forever.
- **Why the fuzz campaign never saw it**: `run()` drains to the horizon in
  one pass and reads its results from final state, so it never depends on
  the clock advancing through an idle window. The bug lived exclusively in
  the incremental API the playground introduced.
- **Fix**: `runUntil` advances the clock to its limit when nothing is due —
  virtual time genuinely passed. Commit `13d4f91`. Trace hashes are
  unaffected (records carry the popped event's `g`, not `sched.now`), which
  the 117-test suite confirmed.
- **Lesson**: "no events" and "no time" are different things. A discrete-
  event scheduler that only advances on event pops is correct for
  batch runs and silently wrong for anything driving it in real-time slices.
