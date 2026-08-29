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
| 8 | Protocol core | Dev | pending | |
| 9 | Simulator | Dev | pending | |
| 10 | Invariants | Dev | pending | |
| 11 | Fuzz campaign | QA | pending | |
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
