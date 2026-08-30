// Fault-profile scenario generation (ADR-0002/0006). The generator draws
// from its own PRNG derived from the seed, then REIFIES the script into the
// Scenario — a failing case replays from the scenario alone even after this
// generator changes. Pure module: no IO, no wall clock.

import { splitmix32, Xoshiro128 } from '../engine/rng.js';
import { validateScenario, type FaultOp, type Scenario } from '../scenario.js';

export const PROFILES = ['mixed', 'partition-heavy', 'crash-heavy', 'clock-chaos'] as const;
export type ProfileName = (typeof PROFILES)[number];

function partitionOf(rng: Xoshiro128, nodes: number): number[][] {
  // Random two-way split with a non-empty smaller side.
  const shuffled = Array.from({ length: nodes }, (_, i) => i);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const a = shuffled[i] as number;
    shuffled[i] = shuffled[j] as number;
    shuffled[j] = a;
  }
  const cut = rng.int(1, nodes - 1);
  return [shuffled.slice(0, cut), shuffled.slice(cut)];
}

export function generateScenario(seed: number, profile: ProfileName): Scenario {
  // Stream separated from the sim's own streams: generator changes must not
  // be able to collide with run-time draws.
  const rng = new Xoshiro128(splitmix32((seed ^ 0x5eed5) >>> 0)());
  const nodes = 5;
  const horizonMs = 60_000;
  const script: FaultOp[] = [];
  const between = (lo: number, hi: number): number => rng.int(lo, hi);

  const addPartitionCycle = (): void => {
    const at = between(2_000, horizonMs - 10_000);
    if (rng.chancePpm(300_000)) {
      // Asymmetric: block a handful of directed links instead of a clean split.
      const links: [number, number][] = [];
      const count = between(1, 4);
      for (let i = 0; i < count; i++) {
        const a = between(0, nodes - 1);
        let b = between(0, nodes - 1);
        if (b === a) b = (b + 1) % nodes;
        links.push([a, b]);
      }
      script.push({ at, op: 'blockLinks', links });
    } else {
      script.push({ at, op: 'partition', groups: partitionOf(rng, nodes) });
    }
    script.push({ at: at + between(3_000, 15_000), op: 'heal' });
  };

  const addCrashCycle = (): void => {
    const node = between(0, nodes - 1);
    const at = between(2_000, horizonMs - 8_000);
    script.push({ at, op: 'crash', node });
    script.push({ at: at + between(2_000, 12_000), op: 'restart', node });
  };

  const addSkew = (): void => {
    script.push({
      at: between(1_000, horizonMs - 5_000),
      op: 'clockSkew',
      node: between(0, nodes - 1),
      offsetMs: between(-300, 300),
      driftPpm: between(-80_000, 80_000),
    });
  };

  let dropPpm = 50_000;
  let dupPpm = 30_000;
  switch (profile) {
    case 'partition-heavy':
      for (let i = between(2, 5); i > 0; i--) addPartitionCycle();
      break;
    case 'crash-heavy':
      for (let i = between(2, 6); i > 0; i--) addCrashCycle();
      break;
    case 'clock-chaos':
      for (let i = between(2, 5); i > 0; i--) addSkew();
      dropPpm = 80_000;
      break;
    case 'mixed':
      dropPpm = 100_000;
      dupPpm = 50_000;
      for (let i = between(1, 3); i > 0; i--) addPartitionCycle();
      for (let i = between(0, 2); i > 0; i--) addCrashCycle();
      for (let i = between(0, 2); i > 0; i--) addSkew();
      break;
  }
  script.sort((a, b) => a.at - b.at);

  const scenario: Scenario = {
    v: 1,
    seed,
    nodes,
    horizonMs,
    net: { delayMs: [5, 60], dropPpm, dupPpm },
    script,
    workload: { clients: 3, opsPerClient: 40, keys: 5 },
  };
  validateScenario(scenario);
  return scenario;
}
