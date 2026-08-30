# Handoff — raftlab

State as of 2026-08-30. **All 15 stages are complete**, merged to main, and
tagged (v0.1–v0.15). Live: https://raftlab-suvros-projects.vercel.app Main is protected with five required CI contexts
(lint, typecheck, test, pack, fuzz-smoke), all green. The repo is at
https://github.com/imSuvro/raftlab.

## What exists and works

- **`@raftlab/core`** — sans-IO Raft state machine (election, replication,
  persistence contract, linearizable client ops via log-routed reads, no-op
  on election win, §5.4.2 commit restriction). 70 curated tests including
  Figure 6/7/8 scenarios and hostile-delivery suites.
- **`@raftlab/sim`** — deterministic simulator: seeded xoshiro128** split
  streams, (dueAtGlobal, seq) heap on integer virtual ms, per-node clocks
  with ppm drift, declarative Scenario fault scripts (partition, asymmetric
  blockLinks, heal, crash/restart with storage, clockSkew), workload harness
  with frozen HistoryEntry recording, FNV-1a trace hashing. Identical seed →
  byte-identical trace, enforced by tests on every PR.
- **Checkers** — election safety, log matching (incremental + full scans),
  leader append-only, leader completeness, state-machine safety, per-key
  Wing&Gong linearizability. Proven to fire (fabricated violations) and
  proven hash-pure.
- **Fuzz campaign** — `pnpm fuzz --seeds a:b --profile <p|all> [--paranoid N]`;
  fixed-point minimizer; `pnpm repro <failure.json>` replays a failure to
  the same violation + trace hash. **10,000 seeds across 4 fault profiles:
  0 violations** (~2,600 seeds/min locally). CI: fuzz-smoke (fixed 500) on
  every PR; nightly.yml runs 5,000/night with rolling seed windows.
- **Docs** — research.md, PRD.md, ux.md (+ wireframe & hi-fi mockup
  artifacts), six ADRs, backlog.md, bugs.md (2 tooling bugs + 1 core
  efficiency bug + 1 not-a-bug triage, fully written up), PROJECT_LOG.md.

## Shipped since

- **Playground** (`apps/playground`): React + Vite, sim in a web worker,
  cluster ring, log wall, narrator captions, scrub-by-rerun, fault controls,
  share URLs. Verified live: kill-the-leader re-elects, partition/heal
  reconciles.
- **Deploy**: Vercel project linked to the GitHub repo — every push to main
  auto-deploys. No token needed locally.
- **Launch docs**: README with the live URL, docs/writeup.md (methodology +
  three bugs seed-to-root-cause), docs/bugs.md (five bugs + one not-a-bug).

## How to run everything

```bash
pnpm install        # pnpm 11, Node >= 20
pnpm test           # 117 tests incl. determinism + regression corpus
pnpm lint && pnpm typecheck
pnpm fuzz --seeds 0:1000 --profile all   # ~25s
pnpm repro fuzz-failures/failure-<seed>.json
```

## NEEDS-HUMAN

- **npm publish**: no npm login on this machine. To publish: `npm login`,
  create the free org `@raftlab` (so the scope isn't sniped), then
  `pnpm publish --access public` in packages/core and packages/sim.
  Metadata/exports/attw are already verified in CI.
- **Optional**: a `VERCEL_TOKEN` repo secret if CI-driven deploys are ever
  wanted; the session's Vercel connector suffices for stage 14.

## Conventions

One branch per stage → PR → green checks → merge → tag `v0.<stage>`.
Conventional commits, no AI-attribution trailers. Determinism is inviolable:
`Date.now`/`Math.random`/timers are lint-banned in core and sim; any
nondeterminism is a bug. Never weaken invariants silently — fallbacks get
ADRs.
