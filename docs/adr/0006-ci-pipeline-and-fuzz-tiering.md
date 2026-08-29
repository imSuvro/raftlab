# ADR-0006: CI pipeline and fuzz tiering

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** Suvra Samajder

## Context

The repo is public on GitHub, so Actions minutes are free but wall-clock
discipline still matters: a PR gate that takes half an hour stops being run.
The fuzz campaign's contract (PRD) is ≥5,000 seeds per full run across fault
profiles. The stage-3 spike measured the event loop at 17.4M events/sec bare
and 3.9M with naive tracing on a dev machine; the working estimate for the
full sim (Raft core + checkers + history recording) is ≥3,000 seeds/min on a
GitHub runner, to be validated when the fuzz CLI exists. Branch protection
needs stable, named check contexts. The task brief's gray-area instruction:
if 5,000 seeds exceed CI comfort, tier the campaign and record the split
here.

## Decision

Two workflows, five required check contexts, two fuzz tiers.

**`ci.yml`** on every PR and push to main — four jobs, each a required
context: `lint`, `typecheck`, `test`, `pack`. The `test` job includes the
determinism test (every scenario run twice, FNV-1a trace hashes must match)
and the committed regression scenarios. `pack` builds and runs
`attw --pack` with the `esm-only` profile on both publishable packages, so
publish-readiness is verified continuously from stage 7, not at launch.

**`fuzz-smoke`** joins `ci.yml` as a fifth required context at stage 11:
the fixed seed range **[0, 500)** across the `mixed` profile on every PR.
Fixed, not rolling: a red PR must be reproducible by anyone checking out
the branch, with no ambiguity about which seeds ran.

**`nightly.yml`** on cron: 4 shards × fault profiles (partition-heavy,
crash-heavy, clock-chaos, mixed), ≥1,250 seeds per shard, ≥5,000 per night.
The base seed rolls as `daysSinceEpoch * 5000 + shard * 1250`, printed in
the job summary — coverage accumulates across nights instead of re-testing
the same 5,000 seeds forever. Nightly also enables `--paranoid` (periodic
full log-matching scans, ADR-0003).

**Failure reporting:** the fuzz CLI writes `fuzz-failures/failure-<seed>.json`
(ADR-0005 shape) and exits non-zero; the workflow uploads the directory as
an artifact and appends a `$GITHUB_STEP_SUMMARY` table —
`| seed | invariant | minimized script | repro command |` — plus a
playground link per failure (the share-URL encoder is the same module), so
a failing seed can be watched, not just replayed.

## Options Considered

### Option A: full 5,000 seeds on every PR

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Wall-clock | ~2 min at the estimate; unbounded as horizons/workloads grow |
| Reproducibility | High (fixed range) |
| Maintenance | Low until it isn't |

**Pros:** maximum per-PR coverage; no tier bookkeeping.
**Cons:** couples PR latency to campaign depth; any future slowdown (longer
horizons, paranoid scans, more workload) lands directly on every PR; rolling
the seeds forward on PRs would break red-PR reproducibility.

### Option B: fuzz only nightly

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Wall-clock | Zero on PR |
| Reproducibility | High |
| Maintenance | Low |

**Pros:** fastest PRs.
**Cons:** a PR can merge a regression the smoke range would have caught in
seconds; bug discovery lags a day; violates the spirit of "determinism
enforced on every PR".

### Option C (chosen): fixed 500-seed smoke on PR + rolling 5,000+ nightly

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium (two tiers, one CLI) |
| Wall-clock | ~10–20 s smoke at the estimate; nightly unconstrained |
| Reproducibility | High on PR (fixed range); nightly base printed in summary |
| Maintenance | Low; tiers share every code path |

**Pros:** PRs stay fast and reproducible; total coverage grows every night;
the same CLI, profiles, and artifact format serve both tiers; headroom if
the seeds/min estimate is off by an order of magnitude.
**Cons:** a bug only reachable outside the smoke range merges and surfaces
next morning — accepted, since the minimized repro lands as a permanent
regression scenario the moment it is found.

## Trade-off Analysis

The tiering exists for headroom, not necessity: at the estimate, 5,000 seeds
is minutes. But PR latency is a product surface for a portfolio repo — a
visitor opens a PR and watches CI — and coupling it to campaign depth means
every future deepening (longer horizons, richer workloads, paranoid scans)
degrades it. The fixed smoke range trades a small coverage window on PRs for
exact reproducibility, which the whole project treats as the cardinal
property. Rolling nightly seeds trades run-to-run comparability for
accumulating coverage, which is the right side of that trade once failures
are archived as self-contained scenarios (ADR-0005) rather than "seed 8472
was red last night".

## Consequences

- **Easier:** branch protection has five stable contexts; a red fuzz-smoke
  is reproducible from the PR alone; publish-readiness cannot rot.
- **Harder:** the fuzz CLI must support seed ranges, profiles, shard math,
  and summary/artifact output from its first version (backlog E1/E4).
- **Revisit:** if the measured rate on a GitHub runner falls below
  ~500 seeds/min, shard the smoke job too; if nightly ever exceeds ~30 min
  a shard, split profiles into separate jobs. Both changes amend this ADR.
