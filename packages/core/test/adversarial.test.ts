// Adversarial delivery tests: hostile schedules hand-fed at the step level.
// No simulator and no fuzzing — every sequence here is a curated, minimal
// reproduction of a delivery pattern a real network can produce: duplicates,
// reorderings, stale-term stragglers, crash/restart seams, split votes, and
// a partitioned ex-leader rejoining. Each test states the trap it guards.
//
// The two properties most tests reduce to:
//   - safety of the log: a stale or duplicated message never truncates,
//     resurrects, or re-appends entries;
//   - exactly-once apply: across a whole hostile sequence, each index is
//     applied at most once (per incarnation — a restart may legally replay).

import { describe, expect, test } from 'vitest';
import {
  init,
  step,
  type Command,
  type DurableState,
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

function ae(
  term: number,
  prevLogIndex: number,
  prevLogTerm: number,
  entries: LogEntry[] = [],
  leaderCommit = 0,
): Message {
  return { kind: 'AppendEntries', term, prevLogIndex, prevLogTerm, entries, leaderCommit };
}

function aeReply(term: number, success: boolean, matchIndex = 0, conflictIndex = 0): Message {
  return { kind: 'AppendEntriesReply', term, success, matchIndex, conflictIndex };
}

function rv(term: number, lastLogIndex: number, lastLogTerm: number): Message {
  return { kind: 'RequestVote', term, lastLogIndex, lastLogTerm };
}

function rvReply(term: number, granted: boolean): Message {
  return { kind: 'RequestVoteReply', term, granted };
}

/** Drive a node to leader of term 1 in a cluster of `peers.length + 1`. */
function makeLeader(id: number, peers: number[]): RaftState {
  const s = node(id, peers);
  step(s, electionTimeout());
  for (const p of peers.slice(0, Math.ceil((peers.length + 1) / 2))) {
    step(s, msg(p, rvReply(1, true)));
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

/** Indices of apply effects, in emission order. */
function applies(effects: Effect[]): number[] {
  return effects
    .filter((e): e is Extract<Effect, { type: 'apply' }> => e.type === 'apply')
    .map((e) => e.index);
}

function clientResults(effects: Effect[]): Extract<Effect, { type: 'clientResult' }>[] {
  return effects.filter(
    (e): e is Extract<Effect, { type: 'clientResult' }> => e.type === 'clientResult',
  );
}

function replyOf(effects: Effect[]): Extract<Message, { kind: 'AppendEntriesReply' }> {
  const r = sends(effects).find((e) => e.msg.kind === 'AppendEntriesReply')?.msg;
  if (r?.kind !== 'AppendEntriesReply') throw new Error('no append reply');
  return r;
}

function voteReplyOf(effects: Effect[]): Extract<Message, { kind: 'RequestVoteReply' }> {
  const r = sends(effects).find((e) => e.msg.kind === 'RequestVoteReply')?.msg;
  if (r?.kind !== 'RequestVoteReply') throw new Error('no vote reply');
  return r;
}

// Durable-storage stand-in: fold persist effects the way ADR-0001 obliges the
// environment to, so restart tests recover from what was actually persisted,
// not from a peek at volatile state.
function makeDurable(): DurableState {
  return { currentTerm: 0, votedFor: null, log: [] };
}

function recordPersists(d: DurableState, effects: Effect[]): void {
  for (const e of effects) {
    if (e.type !== 'persist') continue;
    if (e.hardState !== undefined) {
      d.currentTerm = e.hardState.currentTerm;
      d.votedFor = e.hardState.votedFor;
    }
    if (e.truncateLogFrom !== undefined) d.log.length = e.truncateLogFrom - 1;
    if (e.appendEntries !== undefined) d.log.push(...e.appendEntries);
  }
}

// ------------------------------------------------------- duplication/reorder

describe('duplicated and reordered delivery (§5.3, §5.5)', () => {
  test('duplicated and stale AppendEntries: each index applied exactly once, nothing re-persisted', () => {
    const s = node(0, [1, 2]);
    const a = entry(1, write('a'));
    const b = entry(1, write('b'));
    const c = entry(1, write('c'));
    const all: Effect[] = [];

    // Fresh delivery: append three, commit three.
    all.push(...step(s, msg(1, ae(1, 0, 0, [a, b, c], 3))));
    expect(s.commitIndex).toBe(3);

    // Exact duplicate: ack idempotently, persist nothing, apply nothing.
    const dup = step(s, msg(1, ae(1, 0, 0, [a, b, c], 3)));
    expect(kinds(dup)).not.toContain('persist');
    expect(replyOf(dup)).toMatchObject({ success: true, matchIndex: 3 });
    all.push(...dup);

    // A stale earlier retransmission (strict prefix, older leaderCommit):
    // must not truncate the log or drag commitIndex backwards.
    const stale = step(s, msg(1, ae(1, 0, 0, [a], 1)));
    expect(kinds(stale)).not.toContain('persist');
    expect(replyOf(stale)).toMatchObject({ success: true, matchIndex: 1 });
    all.push(...stale);

    // A stale heartbeat with mid-log prev and old leaderCommit: same story.
    all.push(...step(s, msg(1, ae(1, 2, 1, [], 2))));

    expect(s.log).toEqual([a, b, c]);
    expect(s.commitIndex).toBe(3);
    expect(applies(all)).toEqual([1, 2, 3]); // exactly once each, in order
  });

  test('a genuine conflict truncates once; duplicates and old-term retransmissions cannot resurrect the tail', () => {
    const s = node(0, [1, 2]);
    s.currentTerm = 1;
    s.log = [entry(1), entry(1, write('doomed'))];
    const all: Effect[] = [];

    // New leader of term 2 overwrites the uncommitted index-2 entry.
    const first = step(s, msg(2, ae(2, 1, 1, [entry(2, write('w2'))], 1)));
    expect(first.find((e) => e.type === 'persist' && e.truncateLogFrom !== undefined)).toMatchObject(
      { truncateLogFrom: 2 },
    );
    expect(s.log).toEqual([entry(1), entry(2, write('w2'))]);
    expect(s.commitIndex).toBe(1);
    all.push(...first);

    // Duplicate of the same message: terms now match, so no second truncation,
    // no persist, and the ack is idempotent.
    const dup = step(s, msg(2, ae(2, 1, 1, [entry(2, write('w2'))], 1)));
    expect(kinds(dup)).not.toContain('persist');
    expect(replyOf(dup)).toMatchObject({ success: true, matchIndex: 2 });
    all.push(...dup);

    // The deposed term-1 leader's retransmission arrives late, trying to put
    // 'doomed' back with a generous leaderCommit. Refused outright: one reply,
    // no log change, no commit movement.
    const zombie = step(s, msg(1, ae(1, 1, 1, [entry(1, write('doomed'))], 2)));
    expect(zombie).toEqual([
      {
        type: 'send',
        to: 1,
        msg: { kind: 'AppendEntriesReply', term: 2, success: false, matchIndex: 0, conflictIndex: 0 },
      },
    ]);
    all.push(...zombie);

    expect(s.log).toEqual([entry(1), entry(2, write('w2'))]);
    expect(s.commitIndex).toBe(1);
    expect(applies(all)).toEqual([1]); // the surviving committed prefix, once
  });

  test('pipelined AppendEntries arriving out of order heal by retransmission, never by truncation', () => {
    const s = node(0, [1, 2]);
    const a = entry(1, write('a'));
    const b = entry(1, write('b'));
    const all: Effect[] = [];

    // The second message of the pipeline lands first: prev entry missing.
    const early = step(s, msg(1, ae(1, 1, 1, [b], 0)));
    expect(replyOf(early)).toMatchObject({ success: false, conflictIndex: 1 });
    expect(s.log).toHaveLength(0);
    all.push(...early);

    // The first message arrives, then the retransmission of the second.
    all.push(...step(s, msg(1, ae(1, 0, 0, [a], 0))));
    all.push(...step(s, msg(1, ae(1, 1, 1, [b], 0))));
    expect(s.log).toEqual([a, b]);

    // Commit via heartbeat: both entries apply, once each, in order.
    all.push(...step(s, msg(1, ae(1, 2, 1, [], 2))));
    expect(s.commitIndex).toBe(2);
    expect(applies(all)).toEqual([1, 2]);
  });

  test('duplicated and reordered success replies: commit advances once, the client is answered once', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    const all: Effect[] = [];

    // First ack reaches quorum: commit 2, apply 1..2, answer w1.
    all.push(...step(s, msg(1, aeReply(1, true, 2))));
    expect(s.commitIndex).toBe(2);

    // Duplicate of that ack, a redundant ack from the other peer, and a
    // reordered stale ack (matchIndex 1 after 2): all inert.
    const dup = step(s, msg(1, aeReply(1, true, 2)));
    expect(dup).toEqual([]);
    const other = step(s, msg(2, aeReply(1, true, 2)));
    expect(other).toEqual([]);
    const stale = step(s, msg(1, aeReply(1, true, 1)));
    expect(stale).toEqual([]);
    all.push(...dup, ...other, ...stale);

    expect(s.commitIndex).toBe(2);
    expect(s.matchIndex.get(1)).toBe(2); // never regressed
    expect(s.nextIndex.get(1)).toBe(3);
    expect(applies(all)).toEqual([1, 2]); // exactly once each
    const oks = clientResults(all).filter((r) => r.result.kind === 'ok');
    expect(oks).toEqual([{ type: 'clientResult', opId: 'w1', result: { kind: 'ok' } }]);
  });
});

// ------------------------------------------------------------- stale replies

describe('stale-term replies after the sender moved on (§5.1)', () => {
  test('candidate ignores RequestVoteReply grants left over from its previous election', () => {
    const s = node(0, [1, 2, 3, 4]);
    step(s, electionTimeout()); // term 1 election, lost to time
    step(s, electionTimeout()); // term 2 election
    expect(s).toMatchObject({ role: 'candidate', currentTerm: 2 });

    // Term-1 grants straggle in. If counted, 3 total votes would fake a win.
    expect(step(s, msg(3, rvReply(1, true)))).toEqual([]);
    expect(step(s, msg(4, rvReply(1, true)))).toEqual([]);
    expect(s.role).toBe('candidate');
    expect(s.votesGranted.size).toBe(1); // still only the self-vote

    // Real term-2 grants elect it.
    step(s, msg(1, rvReply(2, true)));
    step(s, msg(2, rvReply(2, true)));
    expect(s).toMatchObject({ role: 'leader', currentTerm: 2 });
    expect(s.log).toEqual([entry(2)]);

    // And a term-2 grant arriving after the win is equally inert.
    expect(step(s, msg(3, rvReply(2, true)))).toEqual([]);
    expect(s.role).toBe('leader');
  });

  test('leader ignores AppendEntriesReply from its earlier term, success and failure alike', () => {
    // Leader of term 2 whose term-1 candidacy also produced traffic.
    const s = node(0, [1, 2]);
    step(s, electionTimeout());
    step(s, electionTimeout());
    step(s, msg(1, rvReply(2, true)));
    expect(s).toMatchObject({ role: 'leader', currentTerm: 2 });

    // A forged-looking stale success (matchIndex 5 > log length): if counted,
    // tryAdvanceCommit would commit the term-2 no-op on a phantom ack.
    expect(step(s, msg(2, aeReply(1, true, 5)))).toEqual([]);
    expect(s.matchIndex.get(2)).toBe(0);
    expect(s.commitIndex).toBe(0);

    // A stale failure must not back up nextIndex or trigger a retry.
    expect(step(s, msg(1, aeReply(1, false, 0, 1)))).toEqual([]);
    expect(s.nextIndex.get(1)).toBe(1);
  });

  test('a refusal reply carrying a higher term deposes the candidate', () => {
    const s = node(0, [1, 2]);
    step(s, electionTimeout());
    const effects = step(s, msg(1, rvReply(4, false)));
    expect(s).toMatchObject({ role: 'follower', currentTerm: 4, votedFor: null });
    expect(s.votesGranted.size).toBe(0);
    expect(effects).toEqual([
      { type: 'persist', hardState: { currentTerm: 4, votedFor: null } },
    ]);
  });
});

// ------------------------------------------------------------ crash/restart

describe('crash and restart at nasty points (Figure 2 durable state)', () => {
  test('a granted vote survives restart: the same-term rival is still refused', () => {
    const cfg: RaftConfig = { ...CFG, id: 0, peers: [1, 2] };
    const durable = makeDurable();
    const { state: s } = init(cfg);
    recordPersists(durable, step(s, msg(1, rv(1, 0, 0)))); // votes for 1
    expect(durable).toMatchObject({ currentTerm: 1, votedFor: 1 });

    // Crash; recover strictly from what was persisted.
    const { state: r, effects: restartEffects } = init(cfg, durable);
    expect(restartEffects).toEqual([{ type: 'resetTimer', timer: 'election' }]);
    expect(r).toMatchObject({ currentTerm: 1, votedFor: 1, role: 'follower' });

    // Rival candidate of the same term: the vote survived, so refuse.
    const rival = step(r, msg(2, rv(1, 0, 0)));
    expect(voteReplyOf(rival)).toMatchObject({ granted: false, term: 1 });
    expect(kinds(rival)).not.toContain('persist');

    // The candidate it voted for re-asks: re-granted without re-persisting.
    const again = step(r, msg(1, rv(1, 0, 0)));
    expect(voteReplyOf(again)).toMatchObject({ granted: true });
    expect(kinds(again)).not.toContain('persist');
  });

  test('the self-vote of a mid-election crash survives; candidacy itself does not', () => {
    const cfg: RaftConfig = { ...CFG, id: 0, peers: [1, 2] };
    const durable = makeDurable();
    const { state: s } = init(cfg);
    recordPersists(durable, step(s, electionTimeout())); // candidate, voted self

    const { state: r } = init(cfg, durable);
    expect(r).toMatchObject({ role: 'follower', currentTerm: 1, votedFor: 0 });

    // A same-term candidate asks: refused, the self-vote is spent.
    expect(voteReplyOf(step(r, msg(1, rv(1, 0, 0))))).toMatchObject({ granted: false, term: 1 });

    // A higher-term candidate is a fresh ballot: granted.
    expect(voteReplyOf(step(r, msg(1, rv(2, 0, 0))))).toMatchObject({ granted: true, term: 2 });
  });

  test('appended entries survive restart: the leader retry re-appends nothing', () => {
    const cfg: RaftConfig = { ...CFG, id: 0, peers: [1, 2] };
    const durable = makeDurable();
    const a = entry(1, write('a'));
    const b = entry(1, write('b'));
    const { state: s } = init(cfg);
    recordPersists(durable, step(s, msg(1, ae(1, 0, 0, [a, b], 0))));
    expect(durable.log).toEqual([a, b]);

    // Crash before the ack reached the leader; recover; the leader retries
    // the identical message. It must be acked, not re-appended.
    const { state: r } = init(cfg, durable);
    expect(r.commitIndex).toBe(0); // volatile, correctly reset
    const retry = step(r, msg(1, ae(1, 0, 0, [a, b], 0)));
    expect(kinds(retry)).not.toContain('persist');
    expect(replyOf(retry)).toMatchObject({ success: true, matchIndex: 2 });
    expect(r.log).toEqual([a, b]);

    // Commit after restart applies each index exactly once in this incarnation.
    const commit = step(r, msg(1, ae(1, 2, 1, [], 2)));
    expect(applies([...retry, ...commit])).toEqual([1, 2]);
  });
});

// ------------------------------------------------------------- split votes

describe('split votes: two candidates of one term (§5.2)', () => {
  test('same-term candidates refuse each other, and the refusals change nothing', () => {
    const s0 = node(0, [1, 2, 3, 4]);
    const s1 = node(1, [0, 2, 3, 4]);
    step(s0, electionTimeout());
    step(s1, electionTimeout());

    // Deliver each candidate's actual RequestVote to the other and route the
    // actual replies back.
    const r01 = voteReplyOf(step(s0, msg(1, rv(1, 0, 0))));
    expect(r01).toMatchObject({ granted: false, term: 1 });
    expect(step(s1, msg(0, r01))).toEqual([]);

    const r10 = voteReplyOf(step(s1, msg(0, rv(1, 0, 0))));
    expect(r10).toMatchObject({ granted: false, term: 1 });
    expect(step(s0, msg(1, r10))).toEqual([]);

    for (const s of [s0, s1]) {
      expect(s.role).toBe('candidate');
      expect(s.currentTerm).toBe(1);
      expect(s.votedFor).toBe(s.config.id);
      expect(s.votesGranted.size).toBe(1);
    }
  });

  test('after a split vote, grants from the lost election never count toward the next term', () => {
    const s = node(0, [1, 2, 3, 4]); // quorum is 3
    step(s, electionTimeout());
    step(s, msg(2, rvReply(1, true)));
    expect(s.role).toBe('candidate'); // 2 of 5: split, no winner

    step(s, electionTimeout()); // term 2
    expect(s.votesGranted.size).toBe(1);

    // The rest of term 1's ballots straggle in, including a duplicate. With
    // the self-vote they would total 4 — a fake landslide if counted.
    step(s, msg(3, rvReply(1, true)));
    step(s, msg(4, rvReply(1, true)));
    step(s, msg(2, rvReply(1, true)));
    expect(s).toMatchObject({ role: 'candidate', currentTerm: 2 });
    expect(s.votesGranted.size).toBe(1);

    // Only genuine term-2 ballots elect it.
    step(s, msg(2, rvReply(2, true)));
    step(s, msg(3, rvReply(2, true)));
    expect(s).toMatchObject({ role: 'leader', currentTerm: 2 });
    expect(s.log).toEqual([entry(2)]);
  });

  test('the losing candidate adopts the rival’s higher term and grants its vote', () => {
    const s1 = node(1, [0, 2, 3, 4]);
    step(s1, electionTimeout()); // candidate of term 1, voted for itself
    const effects = step(s1, msg(0, rv(2, 0, 0)));
    expect(s1).toMatchObject({ role: 'follower', currentTerm: 2, votedFor: 0 });
    expect(s1.votesGranted.size).toBe(0);
    expect(voteReplyOf(effects)).toMatchObject({ granted: true, term: 2 });
    // The vote itself was persisted (last hardState carries votedFor 0).
    const persists = effects.filter(
      (e): e is Extract<Effect, { type: 'persist' }> => e.type === 'persist',
    );
    expect(persists.at(-1)?.hardState).toEqual({ currentTerm: 2, votedFor: 0 });
  });
});

// ------------------------------------------------------ partitioned ex-leader

describe('partitioned ex-leader of term T rejoining at term T+k (§5.1, §5.2)', () => {
  test('the stale ex-leader’s AppendEntries is refused without disturbing the follower', () => {
    const f = node(0, [1, 2]);
    f.currentTerm = 3;
    f.log = [entry(1)];
    f.commitIndex = 1;
    f.lastApplied = 1;
    f.leaderId = 2;

    const effects = step(f, msg(1, ae(1, 1, 1, [entry(1, write('stale'))], 5)));
    // Exactly one effect: the refusal. Critically no resetTimer — a stale
    // leader must not suppress this follower's elections — and no persist,
    // no apply, no commit movement from the stale leaderCommit=5.
    expect(effects).toEqual([
      {
        type: 'send',
        to: 1,
        msg: { kind: 'AppendEntriesReply', term: 3, success: false, matchIndex: 0, conflictIndex: 0 },
      },
    ]);
    expect(f).toMatchObject({ currentTerm: 3, commitIndex: 1, leaderId: 2 });
    expect(f.log).toHaveLength(1);
  });

  test('the ex-leader steps down on the higher-term reply and drains pending ops as unknown', () => {
    const s = makeLeader(0, [1, 2]); // leader of term 1
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    expect(s.pendingClientOps.size).toBe(1);

    const effects = step(s, msg(1, aeReply(4, false, 0, 0)));
    expect(s).toMatchObject({ role: 'follower', currentTerm: 4, votedFor: null, leaderId: null });
    expect(s.nextIndex.size).toBe(0);
    expect(s.matchIndex.size).toBe(0);
    expect(s.pendingClientOps.size).toBe(0);
    expect(effects).toContainEqual({
      type: 'persist',
      hardState: { currentTerm: 4, votedFor: null },
    });
    expect(effects).toContainEqual({ type: 'cancelTimer', timer: 'heartbeat' });
    expect(effects).toContainEqual({ type: 'resetTimer', timer: 'election' });
    expect(effects).toContainEqual({
      type: 'clientResult',
      opId: 'w1',
      result: { kind: 'unknown' },
    });
    expect(sends(effects)).toHaveLength(0); // no retry from a deposed leader
  });

  test('a rejoining ex-leader’s uncommitted tail is overwritten and never acked ok', () => {
    const s = makeLeader(0, [1, 2]); // term 1, log [noop@1]
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    step(s, { type: 'clientRequest', cmd: write('w2'), now: 0 });
    expect(s.log).toHaveLength(3); // noop, w1, w2 — none committed

    // The new term-2 leader (elected without those entries) replicates its
    // own no-op over index 2 with leaderCommit 2.
    const effects = step(s, msg(1, ae(2, 1, 1, [entry(2)], 2)));

    expect(s).toMatchObject({ role: 'follower', currentTerm: 2, leaderId: 1, commitIndex: 2 });
    expect(s.log).toEqual([entry(1), entry(2)]);

    // Both in-flight client ops resolve unknown — never ok, even though an
    // apply now happens at the very index w1 occupied.
    const results = clientResults(effects);
    expect(results.map((r) => r.result.kind).sort()).toEqual(['unknown', 'unknown']);
    expect(results.map((r) => r.opId).sort()).toEqual(['w1', 'w2']);

    // What applies at index 2 is the new leader's no-op, not the dead write.
    const applied = effects.filter(
      (e): e is Extract<Effect, { type: 'apply' }> => e.type === 'apply',
    );
    expect(applied.map((a) => a.index)).toEqual([1, 2]);
    expect(applied[1]?.cmd).toEqual({ kind: 'noop' });
    expect(replyOf(effects)).toMatchObject({ success: true, matchIndex: 2 });
  });
});

// ------------------------------------------------- stale failure-reply floor

describe('stale failure replies and the matchIndex+1 floor (§5.3)', () => {
  test('a delayed failure reply cannot drag nextIndex below matchIndex+1', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    step(s, msg(1, aeReply(1, true, 2))); // proves replication through 2
    expect(s.matchIndex.get(1)).toBe(2);
    expect(s.nextIndex.get(1)).toBe(3);
    expect(s.commitIndex).toBe(2);

    // The delayed failure from before that success finally lands.
    const effects = step(s, msg(1, aeReply(1, false, 0, 1)));
    expect(s.nextIndex.get(1)).toBe(3); // floored at matchIndex+1, not 1
    expect(s.matchIndex.get(1)).toBe(2);
    expect(s.commitIndex).toBe(2);
    // The retry must not re-ship the proven prefix.
    expect(kinds(effects)).toEqual(['send']);
    expect(sends(effects)[0]?.msg).toMatchObject({
      kind: 'AppendEntries',
      prevLogIndex: 2,
      entries: [],
    });
  });

  test('the floor holds for hint-less and absurd hints, and nextIndex never drops below 1', () => {
    const s = makeLeader(0, [1, 2]);
    step(s, { type: 'clientRequest', cmd: write('w1'), now: 0 });
    step(s, msg(1, aeReply(1, true, 1))); // index 1 proven on peer 1
    expect(s.nextIndex.get(1)).toBe(2);

    // Hint-less stale failure (conflictIndex 0): plain decrement would give 1,
    // the floor keeps 2 and the retry starts after the proven prefix.
    const hintless = step(s, msg(1, aeReply(1, false, 0, 0)));
    expect(s.nextIndex.get(1)).toBe(2);
    expect(sends(hintless)[0]?.msg).toMatchObject({ kind: 'AppendEntries', prevLogIndex: 1 });

    // An absurd hint beyond the log cannot push nextIndex forward either.
    step(s, msg(1, aeReply(1, false, 0, 9)));
    expect(s.nextIndex.get(1)).toBe(2);

    // A peer with nothing proven: repeated failures bottom out at 1, never 0.
    step(s, msg(2, aeReply(1, false, 0, 0)));
    expect(s.nextIndex.get(2)).toBe(1);
    const again = step(s, msg(2, aeReply(1, false, 0, 0)));
    expect(s.nextIndex.get(2)).toBe(1);
    expect(sends(again)[0]?.msg).toMatchObject({ kind: 'AppendEntries', prevLogIndex: 0 });
  });
});
