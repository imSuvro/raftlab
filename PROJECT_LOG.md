# raftlab — project log

Raft consensus in TypeScript with deterministic simulation testing, plus a
browser playground for live fault injection. One branch per stage, merged to
main, tagged on completion.

## Stage status

| # | Stage | Role | Status | Tag |
|---|-------|------|--------|-----|
| 1 | Research | Product Owner | done | v0.1 |
| 2 | Product definition (PRD) | Product Owner | done | v0.2 |
| 3 | Feasibility spike | Architect | done | v0.3 |
| 4 | UX | UX Designer | done | v0.4 |
| 5 | Architecture (ADRs) | Architect | done | v0.5 |
| 6 | Planning (backlog) | Product Owner | done | v0.6 |
| 7 | Repo + CI | DevOps | done | v0.7 |
| 8 | Protocol core | Dev | done | v0.8 |
| 9 | Simulator | Dev | done | v0.9 |
| 10 | Invariants | Dev | done | v0.10 |
| 11 | Fuzz campaign | QA | in progress | |
| 12 | Playground | Dev | pending | |
| 13 | Review | QA/Dev | pending | |
| 14 | Deploy | DevOps | pending | |
| 15 | Launch | Product Owner | pending | |

## Decisions

- **2026-08-29** Name/location: `imSuvro/raftlab` at `D:\Personal\raftlab`;
  npm scope `@raftlab` (`@raftlab/core`, `@raftlab/sim`); site target
  `raftlab.vercel.app`. Names verified free on GitHub and npm at decision time.
- **2026-08-29** Conventional commits, no AI-attribution trailers.
- **2026-08-29** Toolchain: pnpm workspaces, TS project references + `tsc -b`
  typecheck, ESM-only library builds via plain `tsc`, Vitest, ESLint flat
  config with a three-rule determinism ban scoped to `packages/{core,sim}`.
- **2026-08-29** Deploys run from the working session via the authenticated
  Vercel connector; CI does not deploy (would need a `VERCEL_TOKEN` secret —
  see NEEDS-HUMAN).
- **2026-08-29** From stage 8 on, stage branches merge to main through pull
  requests so the required CI contexts actually gate them (stages 1–7
  predate the remote and were merged locally). Branch protection: required
  contexts lint/typecheck/test/pack (+ fuzz-smoke from stage 11), no
  required reviews (solo), force-push disabled, not enforced for admins as
  the emergency hatch.
- **2026-08-29** pnpm's ignored-build-scripts default kept; only esbuild's
  postinstall is allow-listed in pnpm-workspace.yaml.

## Stage notes

- **Stage 1 (research)**: 5-source parallel sweep (Raft paper + Students'
  Guide, FoundationDB, TigerBeetle VOPR, Antithesis, TS/JS implementation
  survey) synthesized into `docs/research.md`. Key input for later stages: the
  full extended-paper text sits at
  `C:\Users\Suvro\AppData\Local\Temp\claude\D--Personal-career-os\d08b2c46-62bd-4937-a683-a5194f5e5067\scratchpad\raft-extended.txt`
  (session-local; re-extract from raft.github.io/raft.pdf if gone). Headline
  finding: Antithesis found safety violations in four mature production Raft
  implementations via network faults alone — the differentiation is the
  harness, not the Raft.

- **Stage 5 (architecture)**: five ADRs written in parallel, then a
  cross-consistency review found 6 must-fix contract divergences (workload
  reification shape, v/seed placement in the share URL, stale ux.md fields,
  regression-assertion regime, checker trigger taxonomy, failure-artifact
  shape) — all resolved with canonical rulings before ratification. Notable
  honest deferral recorded in ADR-0002: synchronous per-step persistence
  makes the "crash between state change and persist-ack" window
  unrepresentable; async persistence is a future fault stage.

- **Stage 8 (core)**: state machine written from the paper (Figure 2 +
  §5.4.2 commit restriction + §8 no-op + fast-backup hint with a
  matchIndex+1 floor). Verified three ways: 70 curated tests (foundational
  semantics, Figure 6/7 convergence conversations, 18 hostile-delivery
  scenarios); two adversarial audit lenses (Students'-Guide traps, ADR-0001
  contract) — zero bugs, two nits fixed (stale-failure-reply nextIndex
  regression; misleading docstring); and a 500-run × 2,200-event fuzz probe
  (601k steps, 9k elections, 12k restarts, 159k commits) with election/
  state-machine/commit-safety ledgers — zero violations. Triage note: the
  probe initially reported 3 calm-phase liveness failures; root cause was
  the probe's own driver firing election timeouts at a stale-term leader (a
  correct no-op) instead of driving its heartbeats — protocol exonerated,
  harness fixed, 500/500 clean. Probe kept session-local; the stage-9 sim
  supersedes it.

- **Stage 9 (simulator)**: engine per ADR-0002 — xoshiro128** split
  streams, (dueAtGlobal, seq) heap, per-node clocks with integer-ppm drift,
  declarative Scenario faults (partition/blockLinks/heal/crash/restart/
  clockSkew), open-loop workload with frozen HistoryEntry recording,
  incremental FNV-1a trace hashing with optional tail retention. 21 tests:
  determinism double-runs across calm and storm profiles, partition/heal
  convergence, crash/restart catch-up, lossy-network progress, reified-ops
  hash equality (minimizer contract). Measured throughput: **3,899
  seeds/min** single-threaded (60s-horizon default scenario, ~16.5k
  events/seed) — validates ADR-0006's tiering estimate. Design note: under
  timer-intent semantics an offset-only clock jump is nearly unobservable;
  drift (ppm) is the operative skew fault — documented in scheduler.ts.

- **Stage 10 (invariants)**: CheckerSet per ADR-0003 (election safety, log
  matching incremental + full scans, leader append-only, leader
  completeness via committed-prefix containment, state-machine safety) wired
  after every step; per-key Wing&Gong linearizability with memoization per
  ADR-0004 (indeterminate ops = open intervals; notLeader = never
  linearizes; equal-timestamp touch = concurrent). Every checker proven to
  fire via fabricated violations; observer purity proven (trace hash equal
  with checkers on/off/paranoid). Failure artifacts
  (failure-<seed>.json + hashAtFailure) and `pnpm repro` land per ADR-0005;
  plumbing tested via a deterministic synthetic-sabotage hook. 20 new tests.

## Spike numbers (stage 3)

Measured 2026-08-29, Node v22.22.3, Windows 11, `spike/spike.mjs` (echo
protocol, 5 nodes, (time, seq)-ordered binary heap, xoshiro128** seeded via
splitmix32, FNV-1a trace hash):

- **Determinism**: identical seed → byte-identical trace across 10 in-process
  runs AND across 4 separate OS processes (hash 0xfe5bebd8 every time);
  seed+1 diverges as expected.
- **Throughput**: ~17.4M events/sec without tracing; ~3.9M events/sec with a
  naive per-event string trace. Lesson for stage 9: trace as structured
  records, serialize/hash lazily — string building per event costs 4.5x.
  Even at 100x Raft overhead vs echo, thousands of seeds/minute is safe;
  the CI fuzz-tier estimate (≥3,000 seeds/min) has ample headroom.
- **structuredClone**: 87 µs for a 6.0KB playground-frame-sized view model →
  2.6 ms/sec at 30 Hz. Full-snapshot frames are the right call; no diffing.
- **Scrub feasibility**: one 60-virtual-second run (18.0k events) replays in
  ~1.0 ms → timeline scrubbing re-runs from t=0; no checkpointing needed.

## Bug log

Simulator-found bugs live in `docs/bugs.md` (seed, minimal trace, root cause,
fix commit). Summary counts will be mirrored here as the fuzz campaign runs.

## NEEDS-HUMAN

- **npm publish auth**: `npm whoami` fails on this machine — no npm login.
  Publishing `@raftlab/core` / `@raftlab/sim` (and creating the free npm org
  `@raftlab` so the scope isn't sniped) requires the user to `npm login` and
  run `npm publish --access public` in each package. Packages will be left
  fully publish-ready (metadata, exports map, pack-check green in CI).
- **Optional — CI-driven Vercel deploys**: would require adding a
  `VERCEL_TOKEN` repo secret. Not blocking; the session's Vercel connector
  covers the stage-14 production deploy.
