// Scenario minimization per ADR-0005: shrink the reified inputs with the
// seed held fixed (PRNG stream-splitting keeps unrelated draws stable).
// A shrink is accepted if ANY invariant violation still occurs (the
// standard any-bug criterion — converges fast, and any minimized violation
// is a valid repro). Passes:
//   0. reify the workload spec into an explicit op list
//   1-4, iterated to a fixed point: ddmin(script), ddmin(ops), per-op field
//      simplification, then binary-search horizonMs (time shrinks last —
//      a knife-edge horizon makes the content passes brittle)
//   5. node-count reduction 5 -> 3 when the surviving script allows it
// Pure module — every probe is a captureFailure() run.

import { splitStreams } from '../engine/rng.js';
import { generateWorkloadOps, type World } from '../engine/world.js';
import { captureFailure } from '../harness.js';
import { validateScenario, type FaultOp, type Scenario } from '../scenario.js';

export interface MinimizeResult {
  scenario: Scenario;
  probes: number;
  passesApplied: string[];
}

type Sabotage = ((world: World) => void) | undefined;

/** Classic ddmin over a list: try dropping chunks at doubling granularity,
 *  keep any subset that still fails. */
function ddmin<T>(items: T[], stillFails: (subset: T[]) => boolean): T[] {
  let current = items;
  let chunks = 2;
  while (current.length > 0 && chunks <= current.length * 2) {
    const size = Math.ceil(current.length / chunks);
    let reduced = false;
    for (let i = 0; i < current.length; i += size) {
      const candidate = [...current.slice(0, i), ...current.slice(i + size)];
      if (candidate.length < current.length && stillFails(candidate)) {
        current = candidate;
        chunks = Math.max(2, chunks - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (chunks >= current.length) break;
      chunks = Math.min(current.length, chunks * 2);
    }
  }
  return current;
}

export function minimizeScenario(artifactScenario: Scenario, sabotage?: Sabotage): MinimizeResult {
  let probes = 0;
  const passes: string[] = [];
  const fails = (s: Scenario): boolean => {
    probes++;
    try {
      validateScenario(s);
    } catch {
      return false;
    }
    return captureFailure(s, { keepTraceTail: 0 }, sabotage).violation !== null;
  };

  let current = artifactScenario;

  // Pass 0: reify the workload. Same stream, same draws — behavior-identical.
  if (current.workload !== undefined) {
    const ops = generateWorkloadOps(current, splitStreams(current.seed >>> 0).workload);
    const reified: Scenario = { ...current, ops };
    delete reified.workload;
    if (fails(reified)) {
      current = reified;
      passes.push('reify-workload');
    }
  }

  // Passes 1-4 iterate to a fixed point: shrinking one dimension can make
  // another shrinkable (e.g. removing workload ops shifts PRNG draws and
  // turns a previously load-bearing fault op into noise).
  for (let round = 0; round < 4; round++) {
    let changed = false;

    // Pass 1: ddmin the fault script.
    if (current.script.length > 0) {
      const before = current.script.length;
      const script = ddmin(current.script, (subset) => fails({ ...current, script: subset }));
      if (script.length < before) {
        current = { ...current, script };
        passes.push(`script ${before}->${script.length}`);
        changed = true;
      }
    }

    // Pass 2: ddmin the workload ops.
    if (current.ops !== undefined && current.ops.length > 0) {
      const before = current.ops.length;
      const ops = ddmin(current.ops, (subset) => fails({ ...current, ops: subset }));
      if (ops.length < before) {
        current = { ...current, ops };
        passes.push(`ops ${before}->${ops.length}`);
        changed = true;
      }
    }

    // Pass 3: per-op field simplification.
    {
      let simplified = false;
      const script = [...current.script];
      for (let i = 0; i < script.length; i++) {
        const op = script[i] as FaultOp;
        const variants: FaultOp[] = [];
        if (op.op === 'clockSkew') {
          if (op.offsetMs !== 0) variants.push({ ...op, offsetMs: 0 });
          if (op.driftPpm !== 0) variants.push({ ...op, driftPpm: 0 });
        } else if (op.op === 'partition' && op.groups.length > 2) {
          const flat = op.groups.flat();
          variants.push({ ...op, groups: [[flat[0] as number], flat.slice(1)] });
        } else if (op.op === 'blockLinks' && op.links.length > 1) {
          for (const link of op.links) variants.push({ ...op, links: [link] });
        }
        for (const v of variants) {
          const candidate = [...script.slice(0, i), v, ...script.slice(i + 1)];
          if (fails({ ...current, script: candidate })) {
            script[i] = v;
            simplified = true;
            break;
          }
        }
      }
      if (simplified) {
        current = { ...current, script };
        passes.push('fields');
        changed = true;
      }
    }

    // Pass 4 (last): shrink the horizon to just past the violation. Time
    // shrinks after content: a knife-edge horizon makes content passes
    // brittle (removing an op shifts event timing out of the window).
    {
      const original = current.horizonMs;
      let lo = 1;
      let hi = original;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (fails({ ...current, horizonMs: mid })) hi = mid;
        else lo = mid + 1;
      }
      if (lo < original && fails({ ...current, horizonMs: lo })) {
        current = { ...current, horizonMs: lo };
        passes.push(`horizon ${original}->${lo}`);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Pass 5: fewer nodes, only when the surviving script fits inside them.
  if (current.nodes > 3) {
    const referencesHighNode = current.script.some((op) => {
      if (op.op === 'crash' || op.op === 'restart' || op.op === 'clockSkew') return op.node >= 3;
      if (op.op === 'partition') return op.groups.some((grp) => grp.some((id) => id >= 3));
      if (op.op === 'blockLinks') return op.links.some(([a, b]) => a >= 3 || b >= 3);
      return false;
    });
    if (!referencesHighNode && fails({ ...current, nodes: 3 })) {
      current = { ...current, nodes: 3 };
      passes.push('nodes 5->3');
    }
  }

  return { scenario: current, probes, passesApplied: passes };
}
