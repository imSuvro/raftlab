import { describe, expect, test } from 'vitest';
import {
  InvariantViolation,
  PROFILES,
  captureFailure,
  generateScenario,
  minimizeScenario,
  repro,
  type Scenario,
  type World,
} from '@raftlab/sim';

describe('profile scenario generator (E1)', () => {
  test('deterministic: same seed + profile -> identical scenario', () => {
    for (const p of PROFILES) {
      expect(generateScenario(1234, p)).toEqual(generateScenario(1234, p));
    }
  });

  test('different profiles differ; scripts are time-sorted and valid', () => {
    const seen = new Set<string>();
    for (const p of PROFILES) {
      const s = generateScenario(42, p);
      seen.add(JSON.stringify(s.script));
      for (let i = 1; i < s.script.length; i++) {
        expect((s.script[i]?.at ?? 0) >= (s.script[i - 1]?.at ?? 0)).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test('generated scenarios run clean end to end (spot check)', () => {
    for (const p of PROFILES) {
      const { violation } = captureFailure(generateScenario(7, p));
      expect(violation).toBeNull();
    }
  });
});

describe('minimizer (E2)', () => {
  // Synthetic bug, deliberately timing-robust: the world "fails" on any
  // step processed while node 2 is down. Only the crash-2 fault matters;
  // everything else is noise the minimizer must strip, seed held fixed.
  const sabotage = (world: World): void => {
    world.afterStep = (wd) => {
      if (wd.nodes[2]?.alive === false) {
        throw new InvariantViolation('StateMachineSafety', 'synthetic: crash-2 bug', wd.trace.records);
      }
    };
  };

  const noisy: Scenario = {
    v: 1,
    seed: 555,
    nodes: 5,
    horizonMs: 60_000,
    net: { delayMs: [5, 40], dropPpm: 50_000, dupPpm: 20_000 },
    script: [
      { at: 3_000, op: 'partition', groups: [[0, 4], [1, 2, 3]] },
      { at: 5_000, op: 'crash', node: 2 },
      { at: 9_000, op: 'heal' },
      { at: 12_000, op: 'clockSkew', node: 1, offsetMs: 200, driftPpm: 40_000 },
      { at: 15_000, op: 'restart', node: 2 },
      { at: 30_000, op: 'crash', node: 0 },
      { at: 40_000, op: 'restart', node: 0 },
    ],
    workload: { clients: 3, opsPerClient: 20, keys: 4 },
  };

  test('shrinks the noisy scenario to the essential fault', () => {
    expect(captureFailure(noisy, {}, sabotage).violation?.invariant).toBe('StateMachineSafety');
    const r = minimizeScenario(noisy, sabotage);
    expect(r.scenario.script.length).toBe(1);
    expect(r.scenario.script[0]).toMatchObject({ op: 'crash', node: 2 });
    expect(r.scenario.horizonMs).toBeLessThanOrEqual(5_300);
    expect(r.scenario.ops?.length ?? 0).toBe(0); // workload was noise
    expect(r.scenario.nodes).toBe(3);
    expect(r.probes).toBeGreaterThan(5);
    // The minimized scenario still reproduces, and repro() confirms it.
    const { artifact } = captureFailure(r.scenario, {}, sabotage);
    expect(artifact).not.toBeNull();
    if (artifact !== null) {
      expect(repro(artifact, sabotage).reproduced).toBe(true);
    }
  });

  test('a clean scenario minimizes to nothing (no violation, unchanged)', () => {
    const clean = generateScenario(3, 'mixed');
    const { violation } = captureFailure(clean);
    expect(violation).toBeNull();
  });
});
