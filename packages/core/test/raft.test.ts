// Foundational semantics tests, written against Figure 2 of the extended
// paper. The stage-8 workflow adds the figure-scenario suite (Figures 6/7/8
// and Students'-Guide traps) in paper-scenarios.test.ts; this file locks the
// contract the rest of the repo builds on: effect ordering, vote rules,
// truncation, and the current-term commit restriction.

import { describe, expect, test } from 'vitest';
import {
  cloneState,
  init,
  step,
  type Command,
  type Effect,
  type Input,
  type LogEntry,
  type Message,
  type RaftConfig,
  type RaftState,
} from '@raftlab/core';

const CFG: Omit<RaftConfig, 'id'> = {
  peers: [],
  electionTimeoutMs: [150, 300],
  heartbeatMs: 50,
};

function node(id: number, peers: number[]): RaftState {
  return init({ ...CFG, id, peers }).state;
}

function msg(from: number, m: Message, now = 0): Input {
  return { type: 'message', from, msg: m, now };
}

function electionTimeout(now = 0): Input {
  return { type: 'timeout', timer: 'election', now };
}

function write(opId: string, key = 'k', val = 'v'): Command {
  return { kind: 'write', key, val, opId };
}

function entry(term: number, cmd: Command = { kind: 'noop' }): LogEntry {
  return { term, cmd };
}

/** Drive a node to leader of term 1 in a cluster of `peers.length + 1`. */
function makeLeader(id: number, peers: number[]): RaftState {
  const s = node(id, peers);
  step(s, electionTimeout());
  for (const p of peers.slice(0, Math.ceil((peers.length + 1) / 2))) {
    step(s, msg(p, { kind: 'RequestVoteReply', term: 1, granted: true }));
  }
  expect(s.role).toBe('leader');
  return s;
}

function kinds(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

function sends(effects: Effect[]): Extract<Effect, { type: 'send' }>[] {
  return effects.filter((e): e is Extract<Effect, { type: 'send' }> => e.type === 'send');
}

describe('elections (§5.2)', () => {
  test('election timeout: term bump persisted before any RequestVote leaves', () => {
    const s = node(0, [1, 2]);
    const effects = step(s, electionTimeout());
    expect(s).toMatchObject({ role: 'candidate', currentTerm: 1, votedFor: 0 });
    const persistAt = kinds(effects).indexOf('persist');
    const firstSend = kinds(effects).indexOf('send');
    expect(persistAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeLessThan(firstSend);
    expect(sends(effects)).toHaveLength(2);
  });

  test('quorum of votes wins; no-op appended and broadcast immediately', () => {
    const s = node(0, [1, 2, 3, 4]);
    step(s, electionTimeout());
    step(s, msg(1, { kind: 'RequestVoteReply', term: 1, granted: true }));
    expect(s.role).toBe('candidate'); // 2 of 5 is not a quorum
    const effects = step(s, msg(2, { kind: 'RequestVoteReply', term: 1, granted: true }));
    expect(s.role).toBe('leader');
    expect(s.log).toEqual([entry(1)]);
    const persistAt = kinds(effects).indexOf('persist');
    expect(persistAt).toBeGreaterThanOrEqual(0);
    const ae = sends(effects).filter((e) => e.msg.kind === 'AppendEntries');
    expect(ae).toHaveLength(4);
    for (const e of ae) {
      expect(e.msg).toMatchObject({ prevLogIndex: 0, prevLogTerm: 0 });
      expect((e.msg as Extract<Message, { kind: 'AppendEntries' }>).entries).toEqual([entry(1)]);
    }
  });

  test('duplicate vote replies do not double-count', () => {
    const s = node(0, [1, 2, 3, 4]);
    step(s, electionTimeout());
    step(s, msg(1, { kind: 'RequestVoteReply', term: 1, granted: true }));
    step(s, msg(1, { kind: 'RequestVoteReply', term: 1, granted: true }));
    expect(s.role).toBe('candidate');
  });

  test('single-node cluster elects itself and commits immediately', () => {
    const s = node(0, []);
    const effects = step(s, electionTimeout());
    expect(s.role).toBe('leader');
    expect(s.commitIndex).toBe(1); // the no-op
    expect(kinds(effects)).toContain('apply');
  });

  test('candidate yields to a leader of the same term', () => {
    const s = node(0, [1, 2]);
    step(s, electionTimeout());
    const effects = step(
      s,
      msg(1, { kind: 'AppendEntries', term: 1, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 }),
    );
    expect(s.role).toBe('follower');
    expect(s.leaderId).toBe(1);
    const reply = sends(effects)[0]?.msg;
    expect(reply).toMatchObject({ kind: 'AppendEntriesReply', success: true });
  });
});

describe('vote rules (§5.2, §5.4.1)', () => {
  const rv = (term: number, lastLogIndex: number, lastLogTerm: number): Message => ({
    kind: 'RequestVote',
    term,
    lastLogIndex,
    lastLogTerm,
  });

  function replyOf(effects: Effect[]): Extract<Message, { kind: 'RequestVoteReply' }> {
    const r = sends(effects).find((e) => e.msg.kind === 'RequestVoteReply')?.msg;
    if (r?.kind !== 'RequestVoteReply') throw new Error('no vote reply');
    return r;
  }

  test('stale term is refused and the reply carries the newer term', () => {
    const s = node(0, [1, 2]);
    s.currentTerm = 5;
    const r = replyOf(step(s, msg(1, rv(4, 10, 4))));
    expect(r).toMatchObject({ granted: false, term: 5 });
  });

  test('vote persisted before the grant reply; granting resets election timer', () => {
    const s = node(0, [1, 2]);
    const effects = step(s, msg(1, rv(1, 0, 0)));
    expect(replyOf(effects).granted).toBe(true);
    const ks = kinds(effects);
    expect(ks.indexOf('persist')).toBeLessThan(ks.indexOf('send'));
    expect(ks).toContain('resetTimer');
    expect(s.votedFor).toBe(1);
  });

  test('second candidate of the same term is refused (one vote per term)', () => {
    const s = node(0, [1, 2]);
    step(s, msg(1, rv(1, 0, 0)));
    const r = replyOf(step(s, msg(2, rv(1, 0, 0))));
    expect(r.granted).toBe(false);
  });

  test('re-request from the voted-for candidate is re-granted without re-persist', () => {
    const s = node(0, [1, 2]);
    step(s, msg(1, rv(1, 0, 0)));
    const effects = step(s, msg(1, rv(1, 0, 0)));
    expect(replyOf(effects).granted).toBe(true);
    expect(kinds(effects)).not.toContain('persist');
  });

  test('log up-to-date restriction: shorter same-term log is refused', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1), entry(1)];
    s.currentTerm = 1;
    const r = replyOf(step(s, msg(1, rv(2, 1, 1))));
    expect(r.granted).toBe(false);
  });

  test('log up-to-date restriction: higher last term beats longer log', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1), entry(1), entry(1)];
    s.currentTerm = 2;
    const r = replyOf(step(s, msg(1, rv(3, 1, 2))));
    expect(r.granted).toBe(true);
  });

  test('a higher-term RequestVote converts a leader to follower', () => {
    const s = makeLeader(0, [1, 2]);
    const effects = step(s, msg(2, { kind: 'RequestVote', term: 9, lastLogIndex: 5, lastLogTerm: 8 }));
    expect(s).toMatchObject({ role: 'follower', currentTerm: 9 });
    expect(kinds(effects)).toContain('cancelTimer');
  });
});

describe('log replication (§5.3)', () => {
  const ae = (
    term: number,
    prevLogIndex: number,
    prevLogTerm: number,
    entries: LogEntry[] = [],
    leaderCommit = 0,
  ): Message => ({ kind: 'AppendEntries', term, prevLogIndex, prevLogTerm, entries, leaderCommit });

  function reply(effects: Effect[]): Extract<Message, { kind: 'AppendEntriesReply' }> {
    const r = sends(effects).find((e) => e.msg.kind === 'AppendEntriesReply')?.msg;
    if (r?.kind !== 'AppendEntriesReply') throw new Error('no append reply');
    return r;
  }

  test('missing prev entry: rejected with conflictIndex = log length + 1', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1)];
    s.currentTerm = 1;
    const r = reply(step(s, msg(1, ae(1, 5, 1, [entry(1)]))));
    expect(r).toMatchObject({ success: false, conflictIndex: 2 });
  });

  test('prev term mismatch: conflictIndex is the first index of the conflicting term', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1), entry(2), entry(2), entry(2)];
    s.currentTerm = 3;
    const r = reply(step(s, msg(1, ae(3, 4, 3))));
    expect(r).toMatchObject({ success: false, conflictIndex: 2 });
  });

  test('conflict truncates then appends; persist precedes the ack', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1), entry(2), entry(2)];
    s.currentTerm = 3;
    const effects = step(s, msg(1, ae(3, 1, 1, [entry(3, write('w1'))])));
    expect(s.log).toEqual([entry(1), entry(3, write('w1'))]);
    const ks = kinds(effects);
    expect(ks.indexOf('persist')).toBeLessThan(ks.indexOf('send'));
    const p = effects.find((e) => e.type === 'persist');
    expect(p).toMatchObject({ truncateLogFrom: 2 });
    expect(reply(effects)).toMatchObject({ success: true, matchIndex: 2 });
  });

  test('duplicate/reordered older AppendEntries never truncates (§5.3 trap)', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1), entry(1), entry(1)];
    s.currentTerm = 1;
    // A stale retransmission carrying a strict prefix of what we already have.
    const effects = step(s, msg(1, ae(1, 0, 0, [entry(1)])));
    expect(s.log).toHaveLength(3);
    expect(kinds(effects)).not.toContain('persist');
    expect(reply(effects)).toMatchObject({ success: true, matchIndex: 1 });
  });

  test('heartbeat advances commitIndex to min(leaderCommit, prevLogIndex) and applies in order', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1, write('a')), entry(1, write('b'))];
    s.currentTerm = 1;
    const effects = step(s, msg(1, ae(1, 2, 1, [], 5)));
    expect(s.commitIndex).toBe(2);
    const applies = effects.filter((e) => e.type === 'apply');
    expect(applies.map((a) => a.index)).toEqual([1, 2]);
  });

  test('stale leaderCommit from a duplicate never regresses commitIndex', () => {
    const s = node(0, [1, 2]);
    s.log = [entry(1), entry(1), entry(1)];
    s.currentTerm = 1;
    step(s, msg(1, ae(1, 3, 1, [], 3)));
    expect(s.commitIndex).toBe(3);
    step(s, msg(1, ae(1, 1, 1, [], 2)));
    expect(s.commitIndex).toBe(3);
  });

  test('leader backs up nextIndex on rejection and retries immediately', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    const effects = step(
      s,
      msg(1, { kind: 'AppendEntriesReply', term: 1, success: false, matchIndex: 0, conflictIndex: 1 }),
    );
    expect(s.nextIndex.get(1)).toBe(1);
    const retry = sends(effects)[0]?.msg;
    expect(retry).toMatchObject({ kind: 'AppendEntries', prevLogIndex: 0 });
  });

  test('stale success replies never regress matchIndex', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    step(s, msg(1, { kind: 'AppendEntriesReply', term: 1, success: true, matchIndex: 2, conflictIndex: 0 }));
    expect(s.matchIndex.get(1)).toBe(2);
    step(s, msg(1, { kind: 'AppendEntriesReply', term: 1, success: true, matchIndex: 1, conflictIndex: 0 }));
    expect(s.matchIndex.get(1)).toBe(2);
    expect(s.nextIndex.get(1)).toBe(3);
  });
});

describe('commit restriction (§5.4.2, Figure 8)', () => {
  test('a leader never commits a previous-term entry by counting replicas', () => {
    // Leader of term 4 holding an uncommitted term-2 entry at index 2 (S1 in
    // Figure 8). Replication of index 2 alone must not commit it.
    const s = makeLeader(0, [1, 2, 3, 4]); // term 1... bump to term 4 below
    step(s, msg(1, { kind: 'RequestVote', term: 4, lastLogIndex: 0, lastLogTerm: 0 }));
    expect(s.currentTerm).toBe(4);
    // Hand-build the Figure 8 shape: log = [term1 noop, term2 entry], leader of term 4.
    s.role = 'leader';
    s.leaderId = 0;
    s.log = [entry(1), entry(2, write('old'))];
    s.nextIndex = new Map([[1, 3], [2, 3], [3, 3], [4, 3]]);
    s.matchIndex = new Map([[1, 0], [2, 0], [3, 0], [4, 0]]);
    // A majority acks through index 2 — still must not commit (term 2 ≠ 4).
    step(s, msg(1, { kind: 'AppendEntriesReply', term: 4, success: true, matchIndex: 2, conflictIndex: 0 }));
    step(s, msg(2, { kind: 'AppendEntriesReply', term: 4, success: true, matchIndex: 2, conflictIndex: 0 }));
    expect(s.commitIndex).toBe(0);
    // Now a current-term entry reaches the same majority: everything commits.
    step(s, { type: 'clientRequest', cmd: write('new'), now: 0 });
    step(s, msg(1, { kind: 'AppendEntriesReply', term: 4, success: true, matchIndex: 3, conflictIndex: 0 }));
    step(s, msg(2, { kind: 'AppendEntriesReply', term: 4, success: true, matchIndex: 3, conflictIndex: 0 }));
    expect(s.commitIndex).toBe(3);
  });
});

describe('client operations (§8)', () => {
  test('non-leader answers notLeader with the known leader hint', () => {
    const s = node(0, [1, 2]);
    s.currentTerm = 1;
    step(s, msg(1, { kind: 'AppendEntries', term: 1, prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 }));
    const effects = step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    expect(effects).toContainEqual({
      type: 'clientResult',
      opId: 'w1',
      result: { kind: 'notLeader', hint: 1 },
    });
  });

  test('commit emits apply then ok, in that order', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, msg(1, { kind: 'AppendEntriesReply', term: 1, success: true, matchIndex: 1, conflictIndex: 0 }));
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    const effects = step(
      s,
      msg(1, { kind: 'AppendEntriesReply', term: 1, success: true, matchIndex: 2, conflictIndex: 0 }),
    );
    const ks = kinds(effects);
    expect(ks.indexOf('apply')).toBeGreaterThanOrEqual(0);
    expect(ks.indexOf('apply')).toBeLessThan(ks.indexOf('clientResult'));
    expect(effects).toContainEqual({ type: 'clientResult', opId: 'w1', result: { kind: 'ok' } });
  });

  test('a deposed leader answers unknown for every pending op', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    step(s, { type: 'clientRequest', cmd: write('w2'), now: 0 });
    const effects = step(s, msg(2, { kind: 'RequestVote', term: 5, lastLogIndex: 9, lastLogTerm: 4 }));
    const unknowns = effects.filter(
      (e) => e.type === 'clientResult' && e.result.kind === 'unknown',
    );
    expect(unknowns).toHaveLength(2);
    expect(s.pendingClientOps.size).toBe(0);
  });
});

describe('init and cloneState', () => {
  test('restart recovers durable state and re-applies nothing by itself', () => {
    const { state: s, effects } = init(
      { ...CFG, id: 0, peers: [2, 1] },
      { currentTerm: 7, votedFor: 2, log: [entry(5), entry(7)] },
    );
    expect(s).toMatchObject({ currentTerm: 7, votedFor: 2, role: 'follower', commitIndex: 0 });
    expect(s.config.peers).toEqual([1, 2]); // normalized order
    expect(effects).toEqual([{ type: 'resetTimer', timer: 'election' }]);
  });

  test('cloneState is deep for mutable containers and independent thereafter', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    const c = cloneState(s);
    step(s, { type: 'clientRequest', cmd: write('w2'), now: 0 });
    expect(c.log).toHaveLength(2);
    expect(s.log).toHaveLength(3);
    expect(c.pendingClientOps.size).toBe(1);
    expect(s.pendingClientOps.size).toBe(2);
  });
});
