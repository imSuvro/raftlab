import { describe, expect, test } from 'vitest';
import {
  NodeClock,
  Scheduler,
  Xoshiro128,
  defaultScenario,
  generateWorkloadOps,
  parseScenario,
  runScenario,
  serializeScenario,
  splitStreams,
  type Scenario,
} from '@raftlab/sim';

describe('rng (ADR-0002)', () => {
  test('same seed, same sequence; different seed diverges', () => {
    const a = new Xoshiro128(42);
    const b = new Xoshiro128(42);
    const c = new Xoshiro128(43);
    const seqA = Array.from({ length: 32 }, () => a.nextU32());
    const seqB = Array.from({ length: 32 }, () => b.nextU32());
    const seqC = Array.from({ length: 32 }, () => c.nextU32());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  test('int() stays in range at extremes', () => {
    const r = new Xoshiro128(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(150, 300);
      expect(v).toBeGreaterThanOrEqual(150);
      expect(v).toBeLessThanOrEqual(300);
    }
    expect(r.int(5, 5)).toBe(5);
  });

  test('streams are independent: draining one leaves the others untouched', () => {
    const s1 = splitStreams(99);
    const s2 = splitStreams(99);
    for (let i = 0; i < 500; i++) s1.net.nextU32(); // drain net on one side only
    const timerDraws1 = Array.from({ length: 16 }, () => s1.timer.int(150, 300));
    const timerDraws2 = Array.from({ length: 16 }, () => s2.timer.int(150, 300));
    const workload1 = Array.from({ length: 16 }, () => s1.workload.nextU32());
    const workload2 = Array.from({ length: 16 }, () => s2.workload.nextU32());
    expect(timerDraws1).toEqual(timerDraws2);
    expect(workload1).toEqual(workload2);
  });
});

describe('scheduler (ADR-0002)', () => {
  test('orders by (g, seq): same-time events pop in insertion order', () => {
    const s = new Scheduler();
    s.push(10, { kind: 'timer', node: 1, timer: 'election', gen: 1 });
    s.push(5, { kind: 'timer', node: 2, timer: 'election', gen: 1 });
    s.push(10, { kind: 'timer', node: 3, timer: 'election', gen: 1 });
    s.push(5, { kind: 'timer', node: 4, timer: 'election', gen: 1 });
    const order = [s.pop(), s.pop(), s.pop(), s.pop()].map((e) =>
      e?.ev.kind === 'timer' ? e.ev.node : -1,
    );
    expect(order).toEqual([2, 4, 1, 3]);
  });

  test('scheduling into the past clamps to now (no time travel)', () => {
    const s = new Scheduler();
    s.push(100, { kind: 'timer', node: 0, timer: 'election', gen: 1 });
    s.pop();
    expect(s.now).toBe(100);
    s.push(50, { kind: 'timer', node: 1, timer: 'election', gen: 1 });
    const e = s.pop();
    expect(e?.g).toBe(100);
  });

  test('rejects non-integer times', () => {
    const s = new Scheduler();
    expect(() => s.push(10.5, { kind: 'timer', node: 0, timer: 'election', gen: 1 })).toThrow();
  });
});

describe('node clock (ADR-0002)', () => {
  test('zero drift is the identity mapping', () => {
    const c = new NodeClock();
    expect(c.localAt(1234)).toBe(1234);
    expect(c.globalAtLocal(1234, 0)).toBe(1234);
  });

  test('globalAtLocal returns the least g whose local reading meets the target', () => {
    const c = new NodeClock();
    c.skewAt(0, 0, 50_000); // +5% fast
    for (const target of [1, 7, 150, 300, 9999]) {
      const g = c.globalAtLocal(target, 0);
      expect(c.localAt(g)).toBeGreaterThanOrEqual(target);
      expect(c.localAt(g - 1)).toBeLessThan(target);
    }
  });

  test('negative drift slows the local clock', () => {
    const c = new NodeClock();
    c.skewAt(0, 0, -50_000); // 5% slow
    expect(c.localAt(1000)).toBe(950);
    const g = c.globalAtLocal(950, 0);
    expect(g).toBeLessThanOrEqual(1000);
    expect(c.localAt(g)).toBeGreaterThanOrEqual(950);
  });
});

// Scenario shapes reused by the determinism suite and behavior tests.
function calmScenario(seed: number): Scenario {
  return defaultScenario(seed, { workload: { clients: 3, opsPerClient: 10, keys: 3 } });
}

function stormScenario(seed: number): Scenario {
  return defaultScenario(seed, {
    net: { delayMs: [5, 60], dropPpm: 150_000, dupPpm: 50_000 },
    workload: { clients: 3, opsPerClient: 20, keys: 4 },
    script: [
      { at: 8_000, op: 'partition', groups: [[0, 1], [2, 3, 4]] },
      { at: 18_000, op: 'heal' },
      { at: 25_000, op: 'crash', node: 2 },
      { at: 33_000, op: 'clockSkew', node: 4, offsetMs: 200, driftPpm: 60_000 },
      { at: 38_000, op: 'restart', node: 2 },
    ],
  });
}

describe('determinism (the keystone test, ADR-0005)', () => {
  test('identical seed -> identical trace hash, stats, and history (calm)', () => {
    const a = runScenario(calmScenario(1));
    const b = runScenario(calmScenario(1));
    expect(a.hash).toBe(b.hash);
    expect(a.stats).toEqual(b.stats);
    expect(a.history).toEqual(b.history);
    expect(a.traceRecords).toBe(b.traceRecords);
  });

  test('identical seed -> identical trace hash under partitions, crashes, drops, dupes, skew', () => {
    const a = runScenario(stormScenario(77));
    const b = runScenario(stormScenario(77));
    expect(a.hashHex).toBe(b.hashHex);
    expect(a.stats).toEqual(b.stats);
    expect(a.history).toEqual(b.history);
  });

  test('different seeds -> different traces', () => {
    expect(runScenario(calmScenario(1)).hash).not.toBe(runScenario(calmScenario(2)).hash);
  });

  test('trace-tail retention does not change the hash', () => {
    const a = runScenario(stormScenario(5));
    const b = runScenario(stormScenario(5), { keepTraceTail: 200 });
    expect(a.hash).toBe(b.hash);
  });
});

describe('cluster behavior', () => {
  test('calm cluster elects a leader, commits ops, converges', () => {
    const r = runScenario(calmScenario(3));
    const leaders = r.finalView.filter((n) => n.role === 'leader');
    expect(leaders.length).toBe(1);
    expect(r.maxCommitIndex).toBeGreaterThan(20); // 30 ops + no-ops
    const oks = r.history.filter((h) => h.outcome === 'ok');
    expect(oks.length).toBeGreaterThan(20);
    for (const h of oks) {
      expect(h.returnG).toBeGreaterThanOrEqual(h.invokeG);
      if (h.kind === 'read') expect(h.val !== undefined).toBe(true);
    }
    // Quiet tail (last ops land ~54.5s, horizon 60s): logs fully converge.
    const lens = new Set(r.finalView.map((n) => n.logLength));
    expect(lens.size).toBe(1);
    const commits = new Set(r.finalView.map((n) => n.commitIndex));
    expect(commits.size).toBe(1);
  });

  test('partition + heal reconciles logs and keeps committing', () => {
    const r = runScenario(
      defaultScenario(11, {
        workload: { clients: 2, opsPerClient: 10, keys: 3 },
        script: [
          { at: 5_000, op: 'partition', groups: [[0, 1], [2, 3, 4]] },
          { at: 20_000, op: 'heal' },
        ],
      }),
    );
    expect(r.maxCommitIndex).toBeGreaterThan(10);
    const lens = new Set(r.finalView.map((n) => n.logLength));
    expect(lens.size).toBe(1); // healed and converged by the horizon
  });

  test('crash + restart with storage intact: node rejoins and catches up', () => {
    const r = runScenario(
      defaultScenario(13, {
        workload: { clients: 2, opsPerClient: 10, keys: 3 },
        script: [
          { at: 6_000, op: 'crash', node: 0 },
          { at: 20_000, op: 'restart', node: 0 },
        ],
      }),
    );
    const n0 = r.finalView[0];
    expect(n0?.alive).toBe(true);
    expect(n0?.logLength).toBe(r.finalView[1]?.logLength);
    expect(r.maxCommitIndex).toBeGreaterThan(10);
  });

  test('a lossy network still makes progress', () => {
    const r = runScenario(
      defaultScenario(17, {
        net: { delayMs: [5, 40], dropPpm: 200_000, dupPpm: 0 },
        workload: { clients: 2, opsPerClient: 10, keys: 3 },
      }),
    );
    expect(r.maxCommitIndex).toBeGreaterThan(5);
    expect(r.stats.dropsRandom).toBeGreaterThan(0);
  });

  test('majority-side commits continue during a partition', () => {
    // Partition for the whole run after t=5s; minority {0,1} cannot commit.
    const r = runScenario(
      defaultScenario(19, {
        horizonMs: 30_000,
        workload: { clients: 2, opsPerClient: 8, keys: 2 },
        script: [{ at: 5_000, op: 'partition', groups: [[0, 1], [2, 3, 4]] }],
      }),
    );
    const majorityCommit = Math.max(...r.finalView.slice(2).map((n) => n.commitIndex));
    expect(majorityCommit).toBeGreaterThan(0);
    expect(r.stats.dropsLink).toBeGreaterThan(0);
  });
});

describe('scenario serialization (ADR-0005)', () => {
  test('round-trips exactly', () => {
    const s = stormScenario(123);
    expect(parseScenario(serializeScenario(s))).toEqual(s);
  });

  test('rejects unknown versions, dual workload forms, and float skew', () => {
    const s = calmScenario(1);
    expect(() => parseScenario(serializeScenario({ ...s, v: 2 as unknown as 1 }))).toThrow(/version/);
    expect(() =>
      parseScenario(serializeScenario({ ...s, ops: [] })),
    ).toThrow(/exactly one/);
    expect(() =>
      parseScenario(
        serializeScenario({
          ...s,
          script: [{ at: 10, op: 'clockSkew', node: 0, offsetMs: 1.5, driftPpm: 0 }],
        }),
      ),
    ).toThrow(/integer/);
  });

  test('reified ops replace the generator spec deterministically', () => {
    const spec = calmScenario(21);
    const ops = generateWorkloadOps(spec, splitStreams(spec.seed).workload);
    const reified: Scenario = { ...spec, ops };
    delete reified.workload;
    const a = runScenario(spec);
    const b = runScenario(reified);
    expect(b.hash).toBe(a.hash); // same draws, same world
  });
});
