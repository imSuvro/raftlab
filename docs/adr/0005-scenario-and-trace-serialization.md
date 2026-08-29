# ADR-0005: Scenario and trace serialization for replay

**Status:** Accepted / **Date:** 2026-08-29 / **Deciders:** Suvra Samajder

## Context

A simulator run is a pure function of `(seed, scenario)`. ADR-0002 defines the
Scenario as fully self-contained — version (`v`) and seed (`seed`) included, so
failure JSONs and regression files need no companion data — alongside cluster
shape (`nodes`), network configuration (`net`), the fault script (`script`),
the client workload (`workload`, or its reified `ops` list), and the
virtual-time horizon (`horizonMs`). Three consumers need
that input — or the run it produces — in serialized form:

1. **CI determinism testing.** The stack-wide invariant — identical seed
   implies byte-identical event trace — is only a fact while something checks
   it. FDB's double-run self-check is the model: execute the same input twice,
   compare the traces, fail the PR on divergence.
2. **The fuzz campaign.** A failing seed must reproduce exactly, minimize
   mechanically (ddmin), and survive as a committed regression test that
   outlives the branch it was found on.
3. **The playground.** docs/ux.md ratifies a share URL that reproduces exactly
   what the visitor is looking at, injected faults included, with the seed
   visible as an editable hex field, and requires that a malformed URL never
   errors — it falls back to the default scenario with a toast.

The stage-3 spike bounds the design. The (time, seq)-ordered heap sustains
~17.4M events/sec untraced but ~3.9M when every popped event is formatted into
a trace string as it happens — a 4.5x penalty that would consume the CI fuzz
tier's ≥3,000 seeds/min headroom. Trace capture must do no per-event string
work. Prior art points the same way: TigerBeetle's replay is the same command
with the seed appended, and FDB replays inputs, not recordings; neither ships
the trace as the reproduction artifact.

## Decision

**The unit of replay is the Scenario, never the trace.** `(seed, scenario)`
fully determines a run; anything a run produced can be regenerated from them
at any time on the same code version, so recordings are derived data.

**Scenario serialization.** A Scenario is plain JSON with a leading integer
version field, `v: 1`. A parser encountering any other version rejects loudly
with the version it found and the versions it speaks — never a best-effort
parse, because a misparsed scenario still runs and produces a plausible-looking
but wrong reproduction. For minimization, the generated workload is reified
*on first minimize*: a generated scenario carries `workload` (the generator
spec), and the sim generates client ops deterministically from `workloadRng`;
the minimizer, on its first run against a failure, performs that same
`workloadRng` draw and replaces `workload` with the explicit, timestamped
`ops` list it produces — which the sim honors whenever present (ADR-0002).
ddmin then shrinks the `ops` list with the seed held fixed; every probe is
itself a well-formed `(seed, scenario)` pair and therefore exactly
reproducible when it fails.

**Trace.** The trace is an append-only array of compact records — one per
popped event and one per emitted effect — of shape
`{g, seq, node, kind, ...payload}`. It serves four purposes: (1) the
determinism test — CI runs every scenario twice and asserts equal FNV-1a
hashes over the serialized trace, on every PR; (2) the event-log feed for the
playground UI; (3) the failure fingerprint the minimizer uses to judge whether
a shrunk scenario still fails the same way; (4) the `traceTail` — the last 200
records — embedded in failure artifacts for at-a-glance triage. Records stay
structured objects for the lifetime of the run; JSON serialization and FNV-1a
hashing are lazy, performed once at end of run and only for consumers that ask,
which is what keeps the 4.5x spike penalty off the hot path.

**Failure artifact.** A failing fuzz run writes `failure-<seed>.json`
containing `{scenario, violation, minimizedScenario, traceTail}`. Reproduction
is `pnpm repro failure-<seed>.json`: re-run the scenario at the recorded seed
and assert the same violation and the same trace hash. Minimized scenarios are
committed as regression tests under `packages/sim/test/regressions/*.json` and
replayed on every PR.

**Share URL.** The playground encodes
`#v1.<seed>.<base64url(deflate-raw(JSON(scenario minus v and seed)))>` using
the native `CompressionStream('deflate-raw')` — zero dependencies, available
in every target browser and in Node for the CI encoder. Both `v` and `seed`
ride as plaintext segments so the URL itself shows them and the seed field can
edit the seed; the decoder reassembles them into the Scenario.
Any parse failure — bad base64, bad deflate, bad JSON, wrong version — falls
back to the default scenario with a toast, per docs/ux.md. CI failure
summaries reuse the same encoder, so a failing fuzz seed links straight into
the playground at the exact run that failed.

## Options Considered

### Option A — record-and-replay: the full trace is the artifact

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| High — record and inject paths | Poor — trace I/O dominates runs | Bypassed — replay skips the scheduler | Brittle — artifacts die on any code change |

Pros: replay needs no deterministic re-execution, so it would tolerate
nondeterminism bugs; the artifact is an exact record even after the code
changes; no PRNG bookkeeping during replay.

Cons: a 60-virtual-second echo run already produces ~18k events, and Raft
runs at fuzz horizons produce millions — artifacts are megabytes where a
scenario is kilobytes. A trace is only meaningful against the commit that
produced it, so the regression corpus rots on every refactor. Replaying a
recording exercises none of the scheduler/PRNG machinery the project exists
to test, so replays can never catch a determinism regression. And ddmin over
trace events yields physically impossible histories — deleting a delivery
whose send survives — so minimization would need a causal-consistency
repairer on top.

### Option B — binary or bespoke compact encoding (CBOR, msgpack, custom)

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Medium-high — codec + schema evolution | Marginal gain over deflated JSON | Equal to C | Second serialization surface to version |

Pros: smaller URLs and artifacts; hashing raw bytes is cheaper than hashing
JSON text; schema enforced by construction rather than by validation.

Cons: premature — a scenario is configuration plus a few dozen ops, not
events, and deflate over JSON already lands well inside URL limits. Binary
regression files are undiffable and unreviewable in PRs, and the corpus
being readable is part of its value as a public bug log. A bespoke codec is
new bug surface in the one place a silent decode error changes the run while
looking healthy.

### Option C (chosen) — seed + versioned scenario JSON, lazy trace hashing

| Complexity | Performance | Determinism | Maintenance |
|---|---|---|---|
| Low — one schema, `JSON.parse` + validate | Meets spike targets; hash cost paid once per run | Exercised on every replay | Single versioned schema; corpus diffable |

Pros: artifacts are small, human-readable, and diffable; every replay
re-executes the real scheduler, so each repro doubles as a determinism check;
ddmin over reified ops is well-defined; one JSON form feeds the repro CLI,
the regression corpus, and the URL encoder.

Cons: replays are code-version-relative — a legitimate fix changes the trace
hash of a regression scenario, so committed regressions assert on the
violation, not the hash; canonical key order must be enforced before hashing
or serialization, or two semantically equal scenarios hash differently;
compression availability ties the encoder to platforms with
`CompressionStream`.

## Trade-off Analysis

Scenario-as-artifact trades permanence for meaning. A recorded trace is
forever but says nothing once the code moves; a scenario stays meaningful
across commits because re-running it re-derives everything from current code,
and when its trace hash shifts under a fix, that shift is information, not
corruption. The cost is that `pnpm repro`'s trace-hash assertion is only
exact at the commit that wrote the artifact — acceptable because artifacts
are working files of an investigation, while the durable corpus (regressions)
asserts violations.

Lazy hashing trades memory for throughput. Holding structured records for a
whole run costs heap, but the spike shows the alternative — per-event string
building — costs 4.5x throughput, and the same record array serves the UI
feed, the minimizer fingerprint, and the hash without reformatting. FNV-1a is
deliberately non-cryptographic: the hash compares two runs the harness itself
produced, adversarial input is not in the threat model, and 32 bits is ample
for a divergence alarm; localizing a divergence uses the traces themselves.

Reification trades scenario size for shrinkability. Storing generated ops
inline makes scenarios bigger than a generator config would be, but it is
what makes ddmin sound: deleting an op cannot retroactively change what the
workload "would have generated", and every shrink probe is reproducible by
construction. Deleting ops does shift downstream PRNG consumption in other
components; that is harmless, since determinism is a property of each
`(seed, scenario)` pair, not a promise of similarity between neighboring
pairs.

Loud version rejection trades convenience for trust. Migrating old scenarios
silently would keep old URLs alive, but a wrong-version parse that "mostly
works" produces confident, wrong reproductions — the failure mode this whole
ADR exists to prevent. Old share URLs degrade to the default scenario with a
toast, which docs/ux.md already defines as the universal bad-link behavior.

## Consequences

**Easier.** Every failure is one file and one command from reproduction, and
one click from the playground, since CI and the browser share the encoder.
The regression corpus is reviewable text; a PR adding a regression shows the
minimized scenario in the diff. The determinism invariant is tested by the
same machinery users exercise, not by a parallel harness. The trace hot path
stays allocation-only, keeping fuzz throughput at spike-projected levels.

**Harder.** Trace memory grows with horizon length, so very long runs need a
bounded-retention mode that still feeds hash and traceTail. Canonical JSON
(sorted keys, no insignificant whitespace) must be enforced at every
serialization site or hashes and URL comparisons lie. Schema evolution is
manual: bumping `v` orphans committed regressions until a migration is
written, which is deliberate friction.

**Revisit.** Three recorded tensions, none blocking. (1) The failure artifact
omits the commit SHA, while docs/research.md (lesson 7, TigerBeetle) records
seed and SHA together and `pnpm repro`'s trace-hash assertion is only valid
at the producing commit — the artifact schema should likely grow a `sha`
field when repro lands. (2) docs/ux.md's event-log deltas are
`{g, kind, actors, summary, narratorLine?}` while trace records are
`{g, seq, node, kind, ...payload}`: purpose (2) therefore means the trace is
the *source* the worker maps into presentation deltas at ~30Hz, not the wire
format itself — per-event string work is fine at playground rate, banned at
fuzz rate. (3) Versioning lives in two places, the URL's `v1.` prefix and the
scenario's `v:1` field; the prefix allows rejection before inflating and the
field travels with files that never see a URL, but the two must always bump
together. Revisit Option B only if scenarios outgrow URL practicality —
roughly >2KB compressed — which reified workloads could cause under very
long-horizon shares.
