// Dump real simulator frames for the README GIF. No mockup: this drives the
// same World the fuzz campaign drives, with a partition/heal script, and
// samples clusterView() on a fixed virtual-time grid.
import { writeFileSync } from 'node:fs';
import { World, defaultScenario, type Scenario } from '../../packages/sim/src/index.js';

const PARTITION_AT = 9_000;
const HEAL_AT = 21_000;
const START = 3_000;
const END = 33_000;
const STEP = 600;

const scenario: Scenario = defaultScenario(7, {
  horizonMs: 40_000,
  net: { delayMs: [8, 45], dropPpm: 0, dupPpm: 0 },
  workload: { clients: 3, opsPerClient: 120, keys: 5 },
  script: [
    { at: PARTITION_AT, op: 'partition', groups: [[0, 1], [2, 3, 4]] },
    { at: HEAL_AT, op: 'heal' },
  ],
});

const world = new World(scenario, { collectEvents: true });
const frames: unknown[] = [];

world.runUntil(START);
for (let g = START; g <= END; g += STEP) {
  world.runUntil(g);
  const v = world.clusterView(260);
  frames.push({
    g: v.g,
    partitioned: v.partitions !== null,
    leaderId: v.leaderId,
    nodes: v.nodes.map((n) => ({
      id: n.id,
      role: n.alive ? n.role : 'down',
      term: n.term,
      commitIndex: n.commitIndex,
      logLength: n.logLength,
      logWindow: n.logWindow,
    })),
    inflight: v.inflight.slice(0, 40).map((m) => ({
      from: m.from,
      to: m.to,
      vote: m.kind.startsWith('RequestVote'),
      t: Math.min(1, Math.max(0, (v.g - m.sendG) / Math.max(1, m.deliverG - m.sendG))),
    })),
  });
}

const out = { partitionAt: PARTITION_AT, healAt: HEAL_AT, frames };
writeFileSync(process.argv[2] ?? 'frames.json', JSON.stringify(out));
console.log(`${frames.length} frames, ${START}..${END}ms`);
const last = frames[frames.length - 1] as { nodes: { commitIndex: number; logLength: number }[] };
console.log('final commit/log per node:', last.nodes.map((n) => `${n.commitIndex}/${n.logLength}`).join(' '));
