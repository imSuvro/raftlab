import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CheckerSet,
  InvariantViolation,
  checkLinearizability,
  defaultScenario,
  runScenario,
  type Effect,
  type HistoryEntry,
  type LogEntry,
  type ObservedNode,
} from '@raftlab/sim';
import { captureFailure, repro } from '../src/harness.js';
import { loadFailureArtifact, writeFailureArtifact } from '../src/cli/failure.js';

const w = (term: number, opId: string): LogEntry => ({
  term,
  cmd: { kind: 'write', key: 'k', val: `${opId}=v`, opId },
});
const noop = (term: number): LogEntry => ({ term, cmd: { kind: 'noop' } });

function obs(id: number, role: string, term: number, commitIndex: number, log: LogEntry[]): ObservedNode {
  return { id, alive: true, role, term, commitIndex, log };
}

const appendFx = (entries: LogEntry[]): Effect[] => [{ type: 'persist', appendEntries: entries }];

describe('CheckerSet fires on each fabricated violation (ADR-0003)', () => {
  test('ElectionSafety: two leaders in one term', () => {
    const c = new CheckerSet();
    c.observe(obs(0, 'leader', 3, 0, [noop(3)]), appendFx([noop(3)]), 1);
    expect(() => c.observe(obs(1, 'leader', 3, 0, [noop(3)]), appendFx([noop(3)]), 2)).toThrow(
      /ElectionSafety/,
    );
  });

  test('LeaderAppendOnly: a leader shrinking its own log within a term', () => {
    const c = new CheckerSet();
    c.observe(obs(0, 'leader', 2, 0, [noop(2), w(2, 'a')]), appendFx([w(2, 'a')]), 1);
    expect(() => c.observe(obs(0, 'leader', 2, 0, [noop(2)]), [], 2)).toThrow(/LeaderAppendOnly/);
  });

  test('LeaderCompleteness: elected leader missing a committed entry', () => {
    const c = new CheckerSet();
    // Node 0 commits two entries as leader of term 1.
    c.observe(obs(0, 'leader', 1, 2, [noop(1), w(1, 'a')]), appendFx([noop(1), w(1, 'a')]), 1);
    // Node 1 becomes leader of term 2 with a log that lacks the committed write.
    expect(() =>
      c.observe(obs(1, 'leader', 2, 0, [noop(1), noop(2)]), appendFx([noop(2)]), 2),
    ).toThrow(/LeaderCompleteness/);
  });

  test('StateMachineSafety: different entries applied at one index', () => {
    const c = new CheckerSet();
    c.observe(
      obs(0, 'leader', 1, 1, [w(1, 'a')]),
      [{ type: 'apply', index: 1, cmd: { kind: 'write', key: 'k', val: 'a=v', opId: 'a' } }],
      1,
    );
    expect(() =>
      c.observe(
        obs(1, 'follower', 2, 1, [w(2, 'b')]),
        [{ type: 'apply', index: 1, cmd: { kind: 'write', key: 'k', val: 'b=v', opId: 'b' } }],
        2,
      ),
    ).toThrow(/StateMachineSafety/);
  });

  test('LogMatching (incremental): same index+term, different command', () => {
    const c = new CheckerSet();
    c.observe(obs(0, 'leader', 1, 0, [w(1, 'a')]), appendFx([w(1, 'a')]), 1);
    expect(() => c.observe(obs(1, 'follower', 1, 0, [w(1, 'b')]), appendFx([w(1, 'b')]), 2)).toThrow(
      /LogMatching/,
    );
  });

  test('LogMatching (full scan): divergence below a matching suffix anchor', () => {
    const c = new CheckerSet();
    const a = obs(0, 'follower', 2, 0, [w(1, 'x'), noop(2)]);
    const b = obs(1, 'follower', 2, 0, [w(1, 'y'), noop(2)]);
    expect(() => c.fullScan([a, b], 9)).toThrow(/LogMatching/);
  });

  test('a clean sequence raises nothing', () => {
    const c = new CheckerSet();
    c.observe(obs(0, 'leader', 1, 0, [noop(1)]), appendFx([noop(1)]), 1);
    c.observe(obs(1, 'follower', 1, 0, [noop(1)]), appendFx([noop(1)]), 2);
    c.observe(obs(0, 'leader', 1, 1, [noop(1), w(1, 'a')]), appendFx([w(1, 'a')]), 3);
    c.fullScan([obs(0, 'leader', 1, 1, [noop(1), w(1, 'a')]), obs(1, 'follower', 1, 0, [noop(1)])], 4);
  });
});

describe('linearizability checker (ADR-0004)', () => {
  const H = (
    opId: string,
    kind: 'read' | 'write',
    val: string | null,
    invokeG: number,
    returnG: number | undefined,
    outcome: HistoryEntry['outcome'],
    key = 'k',
  ): HistoryEntry => {
    const h: HistoryEntry = { opId, clientId: 0, kind, key, invokeG, outcome };
    if (val !== undefined) h.val = val;
    if (returnG !== undefined) h.returnG = returnG;
    return h;
  };

  test('write-then-read of the same value linearizes', () => {
    const r = checkLinearizability(
      [H('w1', 'write', 'v1', 0, 10, 'ok'), H('r1', 'read', 'v1', 20, 30, 'ok')],
      99,
    );
    expect(r.opsChecked).toBe(2);
  });

  test('stale read after an overwriting write is a violation', () => {
    expect(() =>
      checkLinearizability(
        [
          H('w1', 'write', 'v1', 0, 10, 'ok'),
          H('w2', 'write', 'v2', 20, 30, 'ok'),
          H('r1', 'read', 'v1', 40, 50, 'ok'),
        ],
        99,
      ),
    ).toThrow(InvariantViolation);
  });

  test('an indeterminate write may linearize to explain a later read', () => {
    checkLinearizability(
      [
        H('w1', 'write', 'v1', 0, 10, 'ok'),
        H('w2', 'write', 'v2', 20, undefined, 'indeterminate'),
        H('r1', 'read', 'v2', 40, 50, 'ok'),
      ],
      99,
    );
  });

  test('an indeterminate write may also never linearize', () => {
    checkLinearizability(
      [
        H('w1', 'write', 'v1', 0, 10, 'ok'),
        H('w2', 'write', 'v2', 20, undefined, 'indeterminate'),
        H('r1', 'read', 'v1', 40, 50, 'ok'),
      ],
      99,
    );
  });

  test('failed (notLeader) ops impose no constraints', () => {
    checkLinearizability(
      [
        H('w1', 'write', 'v1', 0, 10, 'ok'),
        H('w2', 'write', 'v2', 15, 16, 'fail'),
        H('r1', 'read', 'v1', 20, 30, 'ok'),
      ],
      99,
    );
  });

  test('reading a never-written value is a violation', () => {
    expect(() =>
      checkLinearizability([H('r1', 'read', 'ghost', 0, 10, 'ok')], 99),
    ).toThrow(/no linearization/);
  });

  test('concurrent writes allow a read to see either — but not a third order', () => {
    // w1 and w2 overlap; the read (after both) may see either final value.
    checkLinearizability(
      [
        H('w1', 'write', 'v1', 0, 30, 'ok'),
        H('w2', 'write', 'v2', 10, 25, 'ok'),
        H('r1', 'read', 'v1', 40, 50, 'ok'),
      ],
      99,
    );
    checkLinearizability(
      [
        H('w1', 'write', 'v1', 0, 30, 'ok'),
        H('w2', 'write', 'v2', 10, 25, 'ok'),
        H('r2', 'read', 'v2', 40, 50, 'ok'),
      ],
      99,
    );
  });

  test('keys are independent (compositionality)', () => {
    checkLinearizability(
      [
        H('w1', 'write', 'v1', 0, 10, 'ok', 'a'),
        H('w2', 'write', 'v2', 0, 10, 'ok', 'b'),
        H('r1', 'read', 'v1', 20, 30, 'ok', 'a'),
        H('r2', 'read', 'v2', 20, 30, 'ok', 'b'),
      ],
      99,
    );
  });
});

describe('checkers are pure observers wired into every run', () => {
  const storm = (seed: number) =>
    defaultScenario(seed, {
      net: { delayMs: [5, 60], dropPpm: 150_000, dupPpm: 50_000 },
      workload: { clients: 3, opsPerClient: 15, keys: 4 },
      script: [
        { at: 8_000, op: 'partition', groups: [[0, 1], [2, 3, 4]] },
        { at: 18_000, op: 'heal' },
        { at: 25_000, op: 'crash', node: 2 },
        { at: 36_000, op: 'restart', node: 2 },
      ],
    });

  test('storm scenarios pass all invariants + linearizability', () => {
    for (const seed of [101, 202, 303]) {
      const r = runScenario(storm(seed));
      expect(r.linearizability?.opsChecked).toBeGreaterThan(30);
    }
  });

  test('checkers do not perturb the trace hash (on == off == paranoid)', () => {
    const on = runScenario(storm(7));
    const off = runScenario(storm(7), { checkers: false });
    const paranoid = runScenario(storm(7), { paranoidEveryEvents: 1000 });
    expect(on.hash).toBe(off.hash);
    expect(paranoid.hash).toBe(on.hash);
    expect(off.linearizability).toBeUndefined();
  });
});

describe('failure artifacts and repro (D6/D7)', () => {
  const synthetic = (seq: number) => (world: import('@raftlab/sim').World) => {
    world.afterStep = (wd) => {
      if (wd.trace.records >= seq) {
        throw new InvariantViolation('ElectionSafety', 'synthetic sabotage for plumbing test', wd.trace.records);
      }
    };
  };

  test('capture -> write -> load -> repro reproduces exactly', () => {
    const scenario = defaultScenario(4242, { workload: { clients: 2, opsPerClient: 8, keys: 2 } });
    const { violation, artifact } = captureFailure(scenario, {}, synthetic(500));
    expect(violation?.invariant).toBe('ElectionSafety');
    expect(artifact).not.toBeNull();
    if (artifact === null) return;
    expect(artifact.traceTail.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'raftlab-fail-'));
    const path = writeFailureArtifact(dir, artifact);
    const loaded = loadFailureArtifact(path);
    expect(loaded.hashAtFailure).toBe(artifact.hashAtFailure);
    const result = repro(loaded, synthetic(500));
    expect(result).toMatchObject({ reproduced: true });
  });

  test('repro reports honestly when the violation is gone', () => {
    const scenario = defaultScenario(4242, { workload: { clients: 2, opsPerClient: 8, keys: 2 } });
    const { artifact } = captureFailure(scenario, {}, synthetic(500));
    if (artifact === null) throw new Error('expected artifact');
    const result = repro(artifact); // no sabotage: the clean run has no violation
    expect(result.reproduced).toBe(false);
    expect(result.reason).toMatch(/without any violation/);
  });

  test('a clean scenario captures nothing', () => {
    const { violation, artifact } = captureFailure(
      defaultScenario(9, { workload: { clients: 2, opsPerClient: 6, keys: 2 } }),
    );
    expect(violation).toBeNull();
    expect(artifact).toBeNull();
  });
});
