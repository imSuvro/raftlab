// @raftlab/sim — deterministic cluster simulator for @raftlab/core.
// One seeded PRNG, virtual time, declarative fault scripts, and a trace
// hash that makes any nondeterminism a test failure (ADR-0002/0005).

export { splitmix32, Xoshiro128, splitStreams, type RngStreams } from './engine/rng.js';
export { Scheduler, NodeClock, type SimEvent } from './engine/scheduler.js';
export {
  World,
  generateWorkloadOps,
  type NodeView,
  type SimResult,
  type SimStats,
  type WorldOptions,
} from './engine/world.js';
export {
  defaultScenario,
  parseScenario,
  serializeScenario,
  validateScenario,
  RAFT_TIMING,
  type FaultOp,
  type NetProfile,
  type Scenario,
  type WorkloadOp,
  type WorkloadSpec,
} from './scenario.js';
export { Trace, fnv1a, type TraceRecord } from './trace.js';
export type { HistoryEntry } from './history.js';
export { CheckerSet, InvariantViolation, type ObservedNode } from './checkers/invariants.js';
export { checkLinearizability, type LinearizabilityReport } from './checkers/linearizability.js';
export {
  captureFailure,
  repro,
  type CaptureResult,
  type FailureArtifact,
  type ReproResult,
} from './harness.js';
export { minimizeScenario, type MinimizeResult } from './fuzz/minimizer.js';
export { generateScenario, PROFILES, type ProfileName } from './fuzz/profiles.js';
// Note: cli/ modules (failure artifacts, repro) are deliberately NOT
// re-exported — they import node:fs and would break browser consumers.

import { World, type SimResult, type WorldOptions } from './engine/world.js';
import { validateScenario, type Scenario } from './scenario.js';

/** Validate and run one scenario to completion. */
export function runScenario(scenario: Scenario, opts: WorldOptions = {}): SimResult {
  validateScenario(scenario);
  return new World(scenario, opts).run();
}

export const SIM_VERSION = '0.1.0';
