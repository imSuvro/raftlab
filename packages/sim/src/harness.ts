// Violation capture and seed-exact reproduction (ADR-0005). Pure — no IO —
// so the minimizer and the playground can use it; file read/write lives in
// cli/failure.ts.

import { World, type WorldOptions } from './engine/world.js';
import { InvariantViolation } from './checkers/invariants.js';
import { validateScenario, type Scenario } from './scenario.js';
import type { TraceRecord } from './trace.js';

export interface FailureArtifact {
  scenario: Scenario;
  violation: { invariant: string; detail: string; eventSeq: number };
  /** The minimizer replaces this with the shrunk scenario; until a
   *  minimization pass ran it equals `scenario`. */
  minimizedScenario: Scenario;
  traceTail: TraceRecord[];
  /** Trace state at the violating event — repro asserts both. */
  hashAtFailure: string;
  recordsAtFailure: number;
  /** Global virtual time of the violating event (minimizer horizon pass). */
  gAtFailure: number;
}

export interface CaptureResult {
  violation: InvariantViolation | null;
  artifact: FailureArtifact | null;
}

/**
 * Run one scenario with checkers armed; capture a violation as an artifact.
 * `sabotage` exists for tests: it installs deterministic synthetic
 * violations, exercising this plumbing without a core bug.
 */
export function captureFailure(
  scenario: Scenario,
  opts: WorldOptions = {},
  sabotage?: (world: World) => void,
): CaptureResult {
  validateScenario(scenario);
  const world = new World(scenario, { keepTraceTail: 200, checkers: true, ...opts });
  if (sabotage !== undefined) sabotage(world);
  try {
    world.run();
    return { violation: null, artifact: null };
  } catch (err) {
    if (!(err instanceof InvariantViolation)) throw err;
    return {
      violation: err,
      artifact: {
        scenario,
        violation: { invariant: err.invariant, detail: err.detail, eventSeq: err.eventSeq },
        minimizedScenario: scenario,
        traceTail: world.trace.tailRecords(),
        hashAtFailure: world.trace.hashHex,
        recordsAtFailure: world.trace.records,
        gAtFailure: world.sched.now,
      },
    };
  }
}

export interface ReproResult {
  reproduced: boolean;
  reason: string;
}

/** Re-run an artifact's scenario and assert the identical violation at the
 *  identical trace hash (same-commit contract, ADR-0005). */
export function repro(artifact: FailureArtifact, sabotage?: (world: World) => void): ReproResult {
  const { violation, artifact: fresh } = captureFailure(artifact.scenario, {}, sabotage);
  if (violation === null || fresh === null) {
    return { reproduced: false, reason: 'run completed without any violation' };
  }
  if (fresh.violation.invariant !== artifact.violation.invariant) {
    return {
      reproduced: false,
      reason: `different invariant: ${fresh.violation.invariant} (was ${artifact.violation.invariant})`,
    };
  }
  if (fresh.hashAtFailure !== artifact.hashAtFailure || fresh.recordsAtFailure !== artifact.recordsAtFailure) {
    return {
      reproduced: false,
      reason: `trace diverged: ${fresh.hashAtFailure}@${fresh.recordsAtFailure} (was ${artifact.hashAtFailure}@${artifact.recordsAtFailure})`,
    };
  }
  return { reproduced: true, reason: `same violation, same trace ${fresh.hashAtFailure}` };
}
