// Figure-scenario tests, written against the extended paper (Ongaro &
// Ousterhout, "In Search of an Understandable Consensus Algorithm"). Where
// raft.test.ts locks Figure 2's per-rule contract, this file replays the
// paper's worked examples end-to-end with real message traffic between real
// RaftState instances:
//
//   - Figure 7  — the six follower log shapes (a)-(f) vs the term-8 leader,
//                 driven through the actual consistency-check/backup
//                 conversation until the logs converge (§5.3);
//   - Figure 6  — the Log Matching consistency check on a mid-log append;
//   - §5.4.1    — the election restriction over the Figure 7 logs: exactly
//                 which of the seven servers can be elected;
//   - §5.4/§5.4.3 — Leader Completeness end-to-end: commit via a majority,
//                 crash the leader, and show no successor lacking the entry
//                 can win against a majority that holds it.
//
// Every conversation is bounded and message counts are tiny; there is no
// fuzzing here (that is the sim package's job).

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
  type NodeId,
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

function heartbeatTimeout(now = 0): Input {
  return { type: 'timeout', timer: 'heartbeat', now };
}

/** Deterministic entry for an (index, term) pair. Two logs that share an
 *  (index, term) automatically share the command — Log Matching property 1
 *  ("same index and term ⇒ same command", §5.3) holds by construction, so a
 *  deep log-equality assertion checks commands as well as terms. */
function paperEntry(index: number, term: number): LogEntry {
  return { term, cmd: { kind: 'write', key: `x${index}`, val: `t${term}`, opId: `e${index}.${term}` } };
}

function logOf(terms: readonly number[]): LogEntry[] {
  return terms.map((t, i) => paperEntry(i + 1, t));
}

function termsOf(log: readonly LogEntry[]): number[] {
  return log.map((e) => e.term);
}

function appliesIn(effects: readonly Effect[]): number[] {
  return effects
    .filter((e): e is Extract<Effect, { type: 'apply' }> => e.type === 'apply')
    .map((e) => e.index);
}

function appendEntriesCount(effects: readonly Effect[], to: NodeId): number {
  return effects.filter((e) => e.type === 'send' && e.to === to && e.msg.kind === 'AppendEntries')
    .length;
}

function voteReplyOf(effects: readonly Effect[]): Extract<Message, { kind: 'RequestVoteReply' }> {
  const r = effects
    .filter((e): e is Extract<Effect, { type: 'send' }> => e.type === 'send')
    .find((e) => e.msg.kind === 'RequestVoteReply')?.msg;
  if (r?.kind !== 'RequestVoteReply') throw new Error('no RequestVoteReply in effects');
  return r;
}

function aeReplyOf(effects: readonly Effect[]): Extract<Message, { kind: 'AppendEntriesReply' }> {
  const r = effects
    .filter((e): e is Extract<Effect, { type: 'send' }> => e.type === 'send')
    .find((e) => e.msg.kind === 'AppendEntriesReply')?.msg;
  if (r?.kind !== 'AppendEntriesReply') throw new Error('no AppendEntriesReply in effects');
  return r;
}

// ------------------------------------------------------------ tiny network

/** A hand-driven network: live nodes by id, plus every effect each node has
 *  emitted (so tests can count RPCs and observe applies after the fact). */
interface Net {
  nodes: Map<NodeId, RaftState>;
  trace: Map<NodeId, Effect[]>;
}

function netOf(entries: ReadonlyArray<readonly [NodeId, RaftState]>): Net {
  return {
    nodes: new Map(entries),
    trace: new Map(entries.map(([id]) => [id, []])),
  };
}

function traceOf(net: Net, id: NodeId): Effect[] {
  const t = net.trace.get(id);
  if (t === undefined) throw new Error(`no trace for node ${id}`);
  return t;
}

/** Deliver every in-flight message between live nodes, FIFO, until quiet.
 *  Messages addressed to ids absent from the net (crashed or partitioned
 *  servers) are dropped. Bounded so a conversation that fails to converge
 *  fails the test loudly instead of spinning. */
function drain(net: Net, from: NodeId, effects: Effect[], maxDeliveries = 400): void {
  const queue: { from: NodeId; to: NodeId; msg: Message }[] = [];
  const absorb = (src: NodeId, fx: Effect[]): void => {
    const t = net.trace.get(src);
    if (t === undefined) net.trace.set(src, [...fx]);
    else t.push(...fx);
    for (const e of fx) {
      if (e.type === 'send') queue.push({ from: src, to: e.to, msg: e.msg });
    }
  };
  absorb(from, effects);
  let delivered = 0;
  for (let env = queue.shift(); env !== undefined; env = queue.shift()) {
    const target = net.nodes.get(env.to);
    if (target === undefined) continue; // crashed or outside the scenario: dropped
    if (++delivered > maxDeliveries) throw new Error('drain: conversation did not quiesce');
    absorb(env.to, step(target, { type: 'message', from: env.from, msg: env.msg, now: 0 }));
  }
}

// -------------------------------------------------------- Figure 7 fixtures

/** Figure 7: the log of the leader that comes to power for term 8 (indexes
 *  1-10; the number in each box is the term the entry was created in) and
 *  the six follower shapes (a)-(f). Followers may be missing entries (a-b),
 *  carry extra uncommitted entries (c-d), or both (e-f); (f)'s history is
 *  spelled out in the caption — leader for term 2, crashed uncommitted,
 *  leader for term 3, crashed again. Indexes 1-3 (term 1) are the prefix
 *  every log shares; the tests treat that prefix as the committed one. */
const FIG7 = {
  leader: [1, 1, 1, 4, 4, 5, 5, 6, 6, 6],
  a: [1, 1, 1, 4, 4, 5, 5, 6, 6],
  b: [1, 1, 1, 4],
  c: [1, 1, 1, 4, 4, 5, 5, 6, 6, 6, 6],
  d: [1, 1, 1, 4, 4, 5, 5, 6, 6, 6, 7, 7],
  e: [1, 1, 1, 4, 4, 4, 4],
  f: [1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3],
} as const;

const FIG7_IDS: Record<Exclude<keyof typeof FIG7, 'leader'>, NodeId> = {
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  e: 5,
  f: 6,
};

/** The Figure 7 leader, elected for real: it stands for term 8 and wins with
 *  votes from (a), (b) and (e) — three of the four followers whose logs
 *  §5.4.1 lets grant it (see the grant matrix below). Its committed/applied
 *  prefix is 1-3. On winning, the implementation appends its §8 no-op at
 *  index 11, which is what later forces (c)'s and (d)'s uncommitted tails to
 *  be overwritten. */
function fig7Leader(): { leader: RaftState; winFx: Effect[] } {
  const leader = node(0, [1, 2, 3, 4, 5, 6]);
  leader.log = logOf(FIG7.leader);
  leader.currentTerm = 7;
  leader.commitIndex = 3;
  leader.lastApplied = 3;
  step(leader, electionTimeout()); // candidate for term 8
  step(leader, msg(FIG7_IDS.a, { kind: 'RequestVoteReply', term: 8, granted: true }));
  step(leader, msg(FIG7_IDS.b, { kind: 'RequestVoteReply', term: 8, granted: true }));
  const winFx = step(leader, msg(FIG7_IDS.e, { kind: 'RequestVoteReply', term: 8, granted: true }));
  expect(leader.role).toBe('leader');
  expect(leader.currentTerm).toBe(8);
  // §5.3: "it initializes all nextIndex values to the index just after the
  // last one in its log (11 in Figure 7)".
  for (const nx of leader.nextIndex.values()) expect(nx).toBe(11);
  return { leader, winFx };
}

function fig7Follower(id: NodeId, terms: readonly number[]): RaftState {
  const f = node(id, [0, 1, 2, 3, 4, 5, 6].filter((p) => p !== id));
  f.log = logOf(terms);
  f.currentTerm = terms[terms.length - 1] ?? 0;
  return f;
}

// ---------------------------------------------------------------- Figure 7

describe('Figure 7: the term-8 leader repairs every follower shape (§5.3)', () => {
  // maxRpcs encodes §5.3's fast-backup claim: "one AppendEntries RPC will be
  // required for each term with conflicting entries, rather than one RPC per
  // entry" — i.e. the initial probe at nextIndex=11 plus one round per
  // missing/conflicting term span, never a per-entry walk.
  const rows = [
    { label: '(a) missing the last entry', who: 'a', maxRpcs: 2 },
    { label: '(b) missing entries 5-10', who: 'b', maxRpcs: 2 },
    { label: '(c) one extra uncommitted term-6 entry', who: 'c', maxRpcs: 1 },
    { label: '(d) extra uncommitted term-7 entries', who: 'd', maxRpcs: 1 },
    { label: '(e) missing entries plus an extra term-4 tail', who: 'e', maxRpcs: 3 },
    { label: '(f) the term-2/term-3 double-crash tail', who: 'f', maxRpcs: 3 },
  ] as const;

  test.each(rows)('$label converges to the leader log', ({ who, maxRpcs }) => {
    const { leader, winFx } = fig7Leader();
    const id = FIG7_IDS[who];
    const follower = fig7Follower(id, FIG7[who]);
    const net = netOf([
      [0, leader],
      [id, follower],
    ]);
    drain(net, 0, winFx); // the other five followers stay dark

    // §5.3: "Once AppendEntries succeeds, the follower's log is consistent
    // with the leader's, and it will remain that way for the rest of the
    // term" — deep equality, commands included.
    expect(follower.log).toEqual(leader.log);
    expect(follower.currentTerm).toBe(8);
    // Leader Append-Only (Figure 3): repair rewrote the follower, never the
    // leader — its log is still the Figure 7 log plus its own §8 no-op.
    expect(termsOf(leader.log)).toEqual([...FIG7.leader, 8]);
    // No committed entry was lost: the shared committed prefix (1-3, term 1)
    // survived the truncations, was learned committed via leaderCommit, and
    // was applied in order — exactly once.
    expect(appliesIn(traceOf(net, id))).toEqual([1, 2, 3]);
    expect(follower.commitIndex).toBe(3);
    // §5.4.2: one follower's acks (2 of 7 servers) commit nothing new.
    expect(leader.commitIndex).toBe(3);
    // §5.3 fast backup: bounded RPC count, not one probe per entry.
    expect(appendEntriesCount(traceOf(net, 0), id)).toBeLessThanOrEqual(maxRpcs);
  });

  test('repairing a majority commits the whole log through the no-op (§5.4.2, §8)', () => {
    const { leader, winFx } = fig7Leader();
    const a = fig7Follower(FIG7_IDS.a, FIG7.a);
    const b = fig7Follower(FIG7_IDS.b, FIG7.b);
    const c = fig7Follower(FIG7_IDS.c, FIG7.c);
    const net = netOf([
      [0, leader],
      [FIG7_IDS.a, a],
      [FIG7_IDS.b, b],
      [FIG7_IDS.c, c],
    ]);
    drain(net, 0, winFx);
    // Three follower acks + self = 4 of 7. The only entry committed by
    // counting replicas is the term-8 no-op at index 11; entries 4-10 (terms
    // 4, 5, 6) commit transitively: "once an entry from the current term has
    // been committed in this way, then all prior entries are committed
    // indirectly because of the Log Matching Property" (§5.4.2).
    expect(leader.commitIndex).toBe(11);
    expect(appliesIn(traceOf(net, 0))).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    for (const f of [a, b, c]) expect(f.log).toEqual(leader.log);
  });
});

// ---------------------------------------------------------------- Figure 6

describe('Figure 6: the consistency check as the Log Matching induction step (§5.3)', () => {
  // Figure 6's leader log, indexes 1-8, terms as boxed in the figure. Entry
  // 7 is the paper's example of a committed entry (present on 3 of 5).
  const FIG6 = [1, 1, 1, 2, 3, 3, 3, 3] as const;
  const L6 = logOf(FIG6);

  /** An AppendEntries exactly as the Figure 6 leader would build it: prev is
   *  the (index, term) of the entry immediately before the payload, and the
   *  payload is the leader's own entries after prev. */
  function aeAt(prevLogIndex: number, count: number): Message {
    const prev = L6[prevLogIndex - 1];
    return {
      kind: 'AppendEntries',
      term: 3,
      prevLogIndex,
      prevLogTerm: prev === undefined ? 0 : prev.term,
      entries: L6.slice(prevLogIndex, prevLogIndex + count),
      leaderCommit: 0,
    };
  }

  function follower6(terms: readonly number[]): RaftState {
    const f = node(0, [1, 2, 3, 4]);
    f.log = logOf(terms);
    f.currentTerm = 3;
    return f;
  }

  // "When sending an AppendEntries RPC, the leader includes the index and
  // term of the entry ... that immediately precedes the new entries. If the
  // follower does not find an entry in its log with the same index and term,
  // then it refuses the new entries. ... whenever AppendEntries returns
  // successfully, the leader knows that the follower's log is identical to
  // its own log up through the new entries." (§5.3)
  const rows = [
    {
      label: 'mid-log append at matching prev (5, t3) extends a clean prefix',
      follower: [1, 1, 1, 2, 3],
      prevLogIndex: 5,
      count: 2,
      reply: { success: true, matchIndex: 7 },
      finalTerms: [1, 1, 1, 2, 3, 3, 3],
    },
    {
      label: 'prev beyond the log end is refused — nothing is appended blind',
      follower: [1, 1],
      prevLogIndex: 5,
      count: 2,
      reply: { success: false, conflictIndex: 3 },
      finalTerms: [1, 1],
    },
    {
      label: 'prev present with the wrong term is refused, hinting the term-run start',
      follower: [1, 1, 1, 2, 2],
      prevLogIndex: 5,
      count: 3,
      reply: { success: false, conflictIndex: 4 },
      finalTerms: [1, 1, 1, 2, 2],
    },
    {
      label: 'an empty heartbeat at the last entry acks the whole identical log',
      follower: [1, 1, 1, 2, 3, 3, 3, 3],
      prevLogIndex: 8,
      count: 0,
      reply: { success: true, matchIndex: 8 },
      finalTerms: [1, 1, 1, 2, 3, 3, 3, 3],
    },
    {
      label: 'a divergent tail behind matching prev (4, t2) is overwritten with leader entries',
      follower: [1, 1, 1, 2, 2, 2, 2, 2],
      prevLogIndex: 4,
      count: 4,
      reply: { success: true, matchIndex: 8 },
      finalTerms: [1, 1, 1, 2, 3, 3, 3, 3],
    },
  ] as const;

  test.each(rows)('$label', ({ follower, prevLogIndex, count, reply, finalTerms }) => {
    const f = follower6(follower);
    const fx = step(f, msg(1, aeAt(prevLogIndex, count)));
    expect(aeReplyOf(fx)).toMatchObject(reply);
    expect(f.log).toEqual(logOf(finalTerms));
    if (reply.success) {
      // The induction step made concrete: success at prev implies the
      // follower's log equals the leader's through matchIndex — same terms
      // AND same commands, with nothing before prev ever re-sent.
      expect(f.log).toEqual(L6.slice(0, reply.matchIndex));
    }
  });
});

// ----------------------------------------------------- election restriction

describe('election restriction over the Figure 7 logs (§5.4.1)', () => {
  // Last (term, index) per log:
  //   leader (6,10) · a (6,9) · b (4,4) · c (6,11) · d (7,12) · e (4,7) · f (3,11)
  // §5.4.1: "If the logs have last entries with different terms, then the
  // log with the later term is more up-to-date. If the logs end with the
  // same term, then whichever log is longer is more up-to-date."
  // In the 7-node cluster a candidate needs 3 grants besides its own vote.
  const rows = [
    { cand: 'leader', granters: ['a', 'b', 'e', 'f'], wins: true },
    { cand: 'a', granters: ['b', 'e', 'f'], wins: true }, // exactly quorum
    { cand: 'b', granters: ['f'], wins: false },
    { cand: 'c', granters: ['leader', 'a', 'b', 'e', 'f'], wins: true },
    // (d) proves extra *uncommitted* entries never disqualify a candidate —
    // its term-7 tail makes it the most up-to-date log of all.
    { cand: 'd', granters: ['leader', 'a', 'b', 'c', 'e', 'f'], wins: true },
    { cand: 'e', granters: ['b', 'f'], wins: false },
    // (f) holds 11 entries — longer than the leader's log — and still gets
    // no vote at all: length only breaks ties, it never beats a later term.
    { cand: 'f', granters: [], wins: false },
  ] as const;

  test.each(rows)('candidate $cand is granted by exactly the voters $granters', ({ cand, granters, wins }) => {
    const candTerms = FIG7[cand];
    const lastLogIndex = candTerms.length;
    const lastLogTerm = candTerms[lastLogIndex - 1] ?? 0;
    for (const voter of Object.keys(FIG7) as (keyof typeof FIG7)[]) {
      if (voter === cand) continue;
      const v = node(0, [1, 2, 3, 4, 5, 6]);
      v.log = logOf(FIG7[voter]);
      v.currentTerm = 8;
      const fx = step(v, msg(1, { kind: 'RequestVote', term: 9, lastLogIndex, lastLogTerm }));
      const expected = (granters as readonly string[]).includes(voter);
      expect(voteReplyOf(fx).granted, `${voter} voting on ${cand}`).toBe(expected);
    }
    expect(granters.length + 1 >= 4, `${cand} reaching quorum`).toBe(wins);
  });

  test('(d) wins a live election and then repairs the whole cluster (§5.4.1 + §5.3)', () => {
    const members = ['leader', 'a', 'b', 'c', 'd', 'e', 'f'] as const;
    const pairs = members.map((name, id): [NodeId, RaftState] => {
      const s = node(id, [0, 1, 2, 3, 4, 5, 6].filter((p) => p !== id));
      s.log = logOf(FIG7[name]);
      s.currentTerm = 8;
      return [id, s];
    });
    const net = netOf(pairs);
    const d = net.nodes.get(FIG7_IDS.d);
    if (d === undefined) throw new Error('unreachable');
    drain(net, FIG7_IDS.d, step(d, electionTimeout()));
    expect(d.role).toBe('leader');
    expect(d.currentTerm).toBe(9);
    // Leader Append-Only (Figure 3): the winner kept its entire log — the
    // uncommitted term-7 tail included — and added only its §8 no-op.
    expect(termsOf(d.log)).toEqual([...FIG7.d, 9]);
    // §5.3: "the logs automatically converge in response to failures of the
    // AppendEntries consistency check" — every peer, the deposed term-8
    // leader's log included, is forced to duplicate the new leader's.
    for (const [, s] of net.nodes) expect(s.log).toEqual(d.log);
    // The no-op reached all six peers, so it commits — and with it, every
    // preceding entry (§5.4.2).
    expect(d.commitIndex).toBe(13);
  });
});

// ------------------------------------------------------- leader completeness

describe('leader completeness end-to-end (§5.4, §5.4.3, Figure 9)', () => {
  const W1: Command = { kind: 'write', key: 'k', val: 'v', opId: 'w1' };

  /** 5-node cluster. Node 0 wins term 1 with real votes from 1 and 2, then
   *  commits its no-op and the client write w1 on the majority {0, 1, 2}
   *  (§5.3: an entry is committed once the leader that created it has
   *  replicated it on a majority). Nodes 3 and 4 are partitioned throughout
   *  and end with empty logs. The caller then "crashes" node 0 by simply
   *  leaving it out of the next net. */
  function committedWorld(): { n0: RaftState; n1: RaftState; n2: RaftState; n3: RaftState; n4: RaftState } {
    const ids = [0, 1, 2, 3, 4];
    const make = (id: number): RaftState => node(id, ids.filter((p) => p !== id));
    const n0 = make(0);
    const n1 = make(1);
    const n2 = make(2);
    const n3 = make(3);
    const n4 = make(4);
    const majority = netOf([
      [0, n0],
      [1, n1],
      [2, n2],
    ]);
    drain(majority, 0, step(n0, electionTimeout()));
    expect(n0.role).toBe('leader');
    expect(n0.currentTerm).toBe(1);
    drain(majority, 0, step(n0, { type: 'clientRequest', cmd: W1, now: 0 }));
    expect(n0.commitIndex).toBe(2); // [no-op(1), w1] both committed
    expect(traceOf(majority, 0)).toContainEqual({
      type: 'clientResult',
      opId: 'w1',
      result: { kind: 'ok' },
    });
    return { n0, n1, n2, n3, n4 };
  }

  // §5.4.3's contradiction, run forwards: leaderT's majority and any
  // would-be leaderU's majority must intersect in "the voter", and the voter
  // refuses a candidate whose log lacks the committed entry (§5.4.1).
  test.each([
    { usurper: 3, other: 4 },
    { usurper: 4, other: 3 },
  ])('node $usurper, lacking the committed entry, cannot win against the majority that holds it', ({ usurper, other }) => {
    const w = committedWorld();
    const net = netOf([
      [1, w.n1],
      [2, w.n2],
      [3, w.n3],
      [4, w.n4],
    ]); // node 0 crashed
    const cand = net.nodes.get(usurper);
    if (cand === undefined) throw new Error('unreachable');
    // First candidacy (term 1) is refused because 1 and 2 already spent
    // their term-1 vote on the crashed leader (§5.2, one vote per term).
    drain(net, usurper, step(cand, electionTimeout()));
    expect(cand.role).toBe('candidate');
    // Second candidacy (term 2) meets voters whose votedFor is fresh — the
    // only refusal left is §5.4.1's log check, "the voter" of §5.4.3.
    drain(net, usurper, step(cand, electionTimeout()));
    expect(cand.role).toBe('candidate'); // never leader
    expect(cand.currentTerm).toBe(2);
    // Only the other empty-logged node grants: 2 votes of 5 is no quorum.
    expect(cand.votesGranted).toEqual(new Set([usurper, other]));
    for (const holder of [w.n1, w.n2]) {
      expect(holder.currentTerm).toBe(2);
      expect(holder.votedFor).toBeNull(); // refused on log alone, vote unspent
      expect(holder.log[1]).toEqual({ term: 1, cmd: W1 }); // entry untouched
    }
  });

  test('a holder of the committed entry wins and finishes the job: w1 applied everywhere', () => {
    const w = committedWorld();
    const net = netOf([
      [1, w.n1],
      [2, w.n2],
      [3, w.n3],
      [4, w.n4],
    ]); // node 0 stays crashed
    drain(net, 1, step(w.n1, electionTimeout()));
    // Figure 9's voter is node 2: it accepted w1 from the term-1 leader and
    // votes for node 1 — allowed because node 1's log is as up-to-date.
    expect(w.n1.role).toBe('leader');
    expect(w.n1.currentTerm).toBe(2);
    // Leader Completeness (Figure 3): the new leader already holds w1 …
    expect(w.n1.log[1]).toEqual({ term: 1, cmd: W1 });
    // … and §5.4.2: replicating its own term-2 no-op to a majority commits
    // w1 transitively — the term-1 entry is never replica-counted itself.
    expect(w.n1.commitIndex).toBe(3);
    expect(appliesIn(traceOf(net, 1))).toContain(2);
    // One heartbeat spreads leaderCommit; every live node applies w1.
    drain(net, 1, step(w.n1, heartbeatTimeout()));
    for (const id of [2, 3, 4]) {
      const s = net.nodes.get(id);
      if (s === undefined) throw new Error('unreachable');
      expect(s.log).toEqual(w.n1.log);
      expect(s.commitIndex).toBe(3);
      expect(appliesIn(traceOf(net, id))).toContain(2);
    }
  });

  test('the crashed leader restarts from durable state, rejoins, and relearns commitment (Figure 2, §5.3)', () => {
    const w = committedWorld();
    // What Figure 2 says survives a crash: currentTerm, votedFor, log.
    const durable: DurableState = {
      currentTerm: w.n0.currentTerm,
      votedFor: w.n0.votedFor,
      log: [...w.n0.log],
    };
    const net = netOf([
      [1, w.n1],
      [2, w.n2],
      [3, w.n3],
      [4, w.n4],
    ]);
    drain(net, 1, step(w.n1, electionTimeout()));
    expect(w.n1.role).toBe('leader');

    const { state: reborn } = init({ ...CFG, id: 0, peers: [1, 2, 3, 4] }, durable);
    // Volatile state is gone: commitIndex and lastApplied are "initialized
    // to 0" (Figure 2) — the log survived but commitment must be relearned.
    expect(reborn).toMatchObject({ role: 'follower', currentTerm: 1, commitIndex: 0, lastApplied: 0 });
    expect(reborn.log[1]).toEqual({ term: 1, cmd: W1 }); // the crash lost nothing durable

    net.nodes.set(0, reborn);
    net.trace.set(0, []);
    drain(net, 1, step(w.n1, heartbeatTimeout()));
    // §5.3: the leader "includes that index in future AppendEntries RPCs
    // (including heartbeats) so that the other servers eventually find out".
    expect(reborn.log).toEqual(w.n1.log);
    expect(reborn.currentTerm).toBe(2);
    expect(reborn.commitIndex).toBe(3);
    expect(appliesIn(traceOf(net, 0))).toEqual([1, 2, 3]); // reapplied in order
  });
});
