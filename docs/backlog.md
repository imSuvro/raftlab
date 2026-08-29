# Backlog

Dependency-ordered. An item may start only when everything it depends on is
merged. IDs are stable; stages refer to PROJECT_LOG.md. Definitions of done
(DoD) are the merge gates.

## Epic A — Foundation (stage 7)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| A1 | pnpm workspace scaffold (`packages/core`, `packages/sim`, `apps/playground`), tsconfig.base + project references, ESLint flat config with the determinism ban, Vitest workspace | — | `pnpm lint`, `tsc -b`, `pnpm test` all green on empty packages; spike/ deleted |
| A2 | Public GitHub repo `imSuvro/raftlab`, full history pushed | A1 | repo public, tags v0.1–v0.6 visible |
| A3 | CI `ci.yml`: lint · typecheck · test · pack-check (`pnpm pack --dry-run` + attw) | A1 | green on main |
| A4 | Branch protection on main: required checks, no force-push | A2, A3 | `gh api` confirms |
| A5 | ADR-0006: CI pipeline + fuzz tiering | A3 | committed |

## Epic B — Protocol core (stage 8)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| B1 | Core types (`types.ts`): RaftConfig, RaftState, Input, Message, Effect per ADR-0001 — frozen vocabulary | A1 | compiles; exported |
| B2 | Follower/candidate election logic: timers-as-intent, vote rules (§5.2, §5.4.1), persistence-before-reply effect ordering | B1 | unit tests: grant/deny matrix, term bumps, up-to-date restriction |
| B3 | Leader election win path: no-op entry append, heartbeat schedule, nextIndex/matchIndex init | B2 | unit tests vs Figure 2 leader rules |
| B4 | AppendEntries handling: consistency check, conflict truncation, append, commit advancement incl. §5.4.2 current-term rule | B1 | unit tests: Figure 7 log states, Figure 8 scenario |
| B5 | AppendEntries leader side: retry/backoff via conflictIndex, matchIndex quorum, commit rule | B3, B4 | unit tests |
| B6 | Client path: clientRequest → append with opId, clientResult ok/notLeader/unknown, apply effects in order | B5 | unit tests: commit → ok; step-down → unknown |
| B7 | `init(config, recovered)` restart semantics | B1 | unit tests: durable state honored |
| B8 | Table-driven paper-scenario suite (Figures 6, 7, 8; Students'-Guide traps) | B2–B7 | all green; each test cites its figure/rule |

## Epic C — Simulator (stage 9)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| C1 | PRNG (`rng.ts`): splitmix32 + xoshiro128**, stream splitting | A1 | statistical smoke + determinism tests |
| C2 | Scheduler (`scheduler.ts`): (dueAtGlobal, seq) heap, integer-ms virtual time, local↔global clock mapping in the API from day one | C1 | unit tests incl. tie-break determinism |
| C3 | World: nodes wrapping core `step`, SimStorage (survives crash), ordered-effect execution honoring the persistence contract | B8, C2 | echo of spike behavior with real core |
| C4 | Network: per-message delay/drop/dup from netRng, partitions (symmetric groups + directed blockLinks), delivery-time drops | C3 | unit tests per fault |
| C5 | Fault script executor: Scenario.script ops scheduled on the heap; crash/restart; clockSkew (integer ppm drift) | C3 | unit tests |
| C6 | Client workload harness: workloadRng generation from `workload` spec, or replay of reified `ops`; emits HistoryEntry stream per ADR-0004 | C3 | histories recorded; unique opIds |
| C7 | Trace recorder: structured records, lazy FNV-1a hashing; the double-run determinism test | C2–C6 | same seed → same hash, 10 runs, in CI |
| C8 | Scenario module: validation, versioning, JSON round-trip | C5 | round-trip property test |

## Epic D — Invariants + linearizability (stage 10)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| D1 | CheckerSet plumbing: (worldView, event, effects) after every step; across-step derivation of role/commit changes | C7 | wired into sim runs |
| D2 | Election safety + state-machine safety + leader append-only checkers | D1 | seeded synthetic-violation tests (mutate core to prove each checker fires) |
| D3 | Log matching (incremental + end-of-run full scan + --paranoid cadence) | D1 | same |
| D4 | Leader completeness (committed-prefix containment) | D1 | same |
| D5 | Linearizability: history collection + per-key WGL with memoization; indeterminate semantics | C6 | checker unit tests: known-good and known-bad canned histories |
| D6 | Violation flow: InvariantViolation → failure-<seed>.json {scenario, violation, minimizedScenario, traceTail} | D2–D5 | artifact written on induced failure |
| D7 | `pnpm repro <file>`: re-run, assert same violation + trace hash | D6 | works on induced failure |

## Epic E — Fuzz campaign (stage 11)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| E1 | Fuzz CLI: seed ranges, fault profiles (partition-heavy, crash-heavy, clock-chaos, mixed), progress + summary output | D6 | 500 seeds run locally |
| E2 | Minimizer: horizon binary search → ddmin(script) → reify+ddmin(ops) → field shrinking → node-count pass; accept-any-violation rule | E1 | induced failure shrinks to ≤4 ops |
| E3 | CI fuzz-smoke job: fixed seeds [0,500) on PR | E1, A3 | green or reproducibly red |
| E4 | Nightly job: 4 shards × profiles, ≥1,250 seeds each, rolling base seed; artifact upload + step summary with playground links | E3 | first nightly green |
| E5 | Campaign: run ≥5,000 seeds across profiles; fix every bug; docs/bugs.md entries (seed, minimal trace, root cause, fix commit); regression scenarios committed | E2 | zero known failing seeds; bugs.md complete |

## Epic F — Playground (stage 12)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| F1 | Vite + React scaffold, worker bootstrap, sim-in-worker with frame loop | C7 | 5-node cluster runs in browser |
| F2 | Cluster stage per ux.md: ring, role halos, pulses, partition wall, dead-node treatment | F1, ux.md | matches mockup |
| F3 | Log wall with commit watermark + reconcile animation | F1 | matches mockup |
| F4 | Event log panel (virtualized, filters) + narrator captions from sim deltas | F1 | narrator lines fire on election/fault/heal |
| F5 | Transport: pause/step/speed, timeline with fault markers, scrub-by-rerun | F1 | scrub replays identically |
| F6 | Fault controls + node popover (kill/restart/skew), hint chip | F2 | four-second thesis works |
| F7 | Share URLs: encode/decode per ADR-0005; violation message surfaced (dev flag) | F5 | round-trip + cross-tab reproduce |
| F8 | Mobile layout + reduced-motion + a11y floor per ux.md | F2–F7 | mobile viewport verified |

## Epic G — Ship (stages 13–15)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| G1 | Full-codebase review (engineering:code-review); fix findings | E5, F8 | findings closed |
| G2 | Cross-browser + mobile pass on playground | F8 | Chromium + mobile viewport verified |
| G3 | Deploy checklist + `vercel --prod` via connector; live verification (kill leader, partition+heal) | G1, G2 | live URL interactive |
| G4 | README (recruiter-facing: what/why, architecture diagram, live URL, GIF) | G3 | complete |
| G5 | docs/writeup.md: methodology + 3 best bugs seed→root-cause | E5 | complete |
| G6 | npm publish-readiness: metadata, exports, attw clean; NEEDS-HUMAN for auth | A3 | pack-check green |

## Sequencing notes

- B and C1/C2 can interleave (C1/C2 depend only on the scaffold), but C3+
  waits for the full core test suite (B8) — the sim drives a *tested* core.
- The stage-3 spike is deleted at A1; its findings live in PROJECT_LOG.md.
- E5 is the campaign, not the tooling: its DoD is "clean at scale", and it
  is expected to loop back into Epic B fixes. Every fix lands with its
  regression scenario in the same commit.
- F2–F7 implement the ratified ux.md contract; any deviation goes back
  through ux.md first (one line of doc change before one line of code).
