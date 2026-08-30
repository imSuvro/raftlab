// The Raft state machine, written from the extended paper (Ongaro &
// Ousterhout) — Figure 2 plus the §5.4.2 commit restriction, the §8 no-op
// entry, and the §5.3 fast-backup hint. Sans-IO: this module never touches
// time, randomness, or the network; it consumes Inputs and returns an
// ordered Effect list. The environment must make every persist effect
// durable before acting on any effect after it (ADR-0001).

import type {
  ClientResult,
  Command,
  DurableState,
  Effect,
  Input,
  LogEntry,
  LogIndex,
  Message,
  NodeId,
  OpId,
  RaftConfig,
  RaftState,
  Term,
} from './types.js';

export function lastLogIndex(state: RaftState): LogIndex {
  return state.log.length;
}

export function lastLogTerm(state: RaftState): Term {
  const last = state.log[state.log.length - 1];
  return last === undefined ? 0 : last.term;
}

function entryAt(state: RaftState, index: LogIndex): LogEntry | undefined {
  return state.log[index - 1];
}

function quorum(state: RaftState): number {
  return Math.floor((state.config.peers.length + 1) / 2) + 1;
}

export function init(
  config: RaftConfig,
  recovered?: DurableState,
): { state: RaftState; effects: Effect[] } {
  const state: RaftState = {
    config: { ...config, peers: [...config.peers].sort((a, b) => a - b) },
    currentTerm: recovered?.currentTerm ?? 0,
    votedFor: recovered?.votedFor ?? null,
    log: recovered ? [...recovered.log] : [],
    role: 'follower',
    commitIndex: 0,
    lastApplied: 0,
    leaderId: null,
    votesGranted: new Set(),
    nextIndex: new Map(),
    matchIndex: new Map(),
    pendingClientOps: new Map(),
  };
  return { state, effects: [{ type: 'resetTimer', timer: 'election' }] };
}

export function cloneState(state: RaftState): RaftState {
  return {
    config: { ...state.config, peers: [...state.config.peers] },
    currentTerm: state.currentTerm,
    votedFor: state.votedFor,
    log: [...state.log], // entries are immutable; sharing references is safe
    role: state.role,
    commitIndex: state.commitIndex,
    lastApplied: state.lastApplied,
    leaderId: state.leaderId,
    votesGranted: new Set(state.votesGranted),
    nextIndex: new Map(state.nextIndex),
    matchIndex: new Map(state.matchIndex),
    pendingClientOps: new Map(state.pendingClientOps),
  };
}

export function step(state: RaftState, input: Input): Effect[] {
  switch (input.type) {
    case 'message':
      return onMessage(state, input.from, input.msg);
    case 'timeout':
      return input.timer === 'election' ? onElectionTimeout(state) : onHeartbeatTimeout(state);
    case 'clientRequest':
      return onClientRequest(state, input.cmd);
  }
}

// ---------------------------------------------------------------- helpers

/** Figure 2, all servers: term T > currentTerm ⇒ adopt T, become follower.
 *  Returns the persist effect (caller places it before anything it sends). */
function adoptTerm(state: RaftState, term: Term, effects: Effect[]): void {
  const wasLeader = state.role === 'leader';
  state.currentTerm = term;
  state.votedFor = null;
  state.leaderId = null;
  becomeFollower(state);
  effects.push({
    type: 'persist',
    hardState: { currentTerm: state.currentTerm, votedFor: state.votedFor },
  });
  if (wasLeader) {
    effects.push({ type: 'cancelTimer', timer: 'heartbeat' });
    effects.push({ type: 'resetTimer', timer: 'election' });
  }
}

/** Role bookkeeping shared by every path that leaves candidacy/leadership.
 *  Does NOT touch pendingClientOps: a deposed leader's pending ops are
 *  drained as clientResult(unknown) by the term-bump path in onMessage. */
function becomeFollower(state: RaftState): void {
  state.role = 'follower';
  state.votesGranted.clear();
  state.nextIndex.clear();
  state.matchIndex.clear();
}

function drainPendingAsUnknown(state: RaftState, effects: Effect[]): void {
  for (const opId of state.pendingClientOps.values()) {
    effects.push({ type: 'clientResult', opId, result: { kind: 'unknown' } });
  }
  state.pendingClientOps.clear();
}

/** Advance lastApplied through commitIndex, emitting apply effects in order,
 *  plus clientResult(ok) for entries this leader is vouching for. */
function emitApplies(state: RaftState, effects: Effect[]): void {
  while (state.lastApplied < state.commitIndex) {
    state.lastApplied++;
    const entry = entryAt(state, state.lastApplied);
    /* istanbul ignore next -- commitIndex never exceeds the log */
    if (entry === undefined) throw new Error(`apply past end of log: ${state.lastApplied}`);
    effects.push({ type: 'apply', index: state.lastApplied, cmd: entry.cmd });
    const opId = state.pendingClientOps.get(state.lastApplied);
    if (opId !== undefined) {
      state.pendingClientOps.delete(state.lastApplied);
      effects.push({ type: 'clientResult', opId, result: { kind: 'ok' } });
    }
  }
}

function appendEntriesFor(state: RaftState, peer: NodeId): Message {
  const next = state.nextIndex.get(peer) ?? lastLogIndex(state) + 1;
  const prevLogIndex = next - 1;
  const prevEntry = entryAt(state, prevLogIndex);
  return {
    kind: 'AppendEntries',
    term: state.currentTerm,
    prevLogIndex,
    prevLogTerm: prevEntry === undefined ? 0 : prevEntry.term,
    entries: state.log.slice(next - 1),
    leaderCommit: state.commitIndex,
  };
}

function broadcastAppendEntries(state: RaftState, effects: Effect[]): void {
  for (const peer of state.config.peers) {
    effects.push({ type: 'send', to: peer, msg: appendEntriesFor(state, peer) });
  }
  // Replication traffic doubles as the heartbeat.
  effects.push({ type: 'resetTimer', timer: 'heartbeat' });
}

/** Figure 2 leader rule + §5.4.2: only entries of currentTerm commit by
 *  counting replicas; earlier terms commit transitively. */
function tryAdvanceCommit(state: RaftState, effects: Effect[]): void {
  const n = state.config.peers.length + 1;
  for (let candidate = lastLogIndex(state); candidate > state.commitIndex; candidate--) {
    const entry = entryAt(state, candidate);
    if (entry === undefined || entry.term !== state.currentTerm) break;
    let count = 1; // self — the leader's own persist is its ack
    for (const m of state.matchIndex.values()) if (m >= candidate) count++;
    if (count * 2 > n) {
      state.commitIndex = candidate;
      emitApplies(state, effects);
      return;
    }
  }
}

// ---------------------------------------------------------------- timeouts

function onElectionTimeout(state: RaftState): Effect[] {
  if (state.role === 'leader') return []; // stale timer; leaders do not run elections
  const effects: Effect[] = [];
  state.currentTerm++;
  state.votedFor = state.config.id;
  state.role = 'candidate';
  state.leaderId = null;
  state.votesGranted = new Set([state.config.id]);
  effects.push({
    type: 'persist',
    hardState: { currentTerm: state.currentTerm, votedFor: state.votedFor },
  });
  effects.push({ type: 'resetTimer', timer: 'election' });
  for (const peer of state.config.peers) {
    effects.push({
      type: 'send',
      to: peer,
      msg: {
        kind: 'RequestVote',
        term: state.currentTerm,
        lastLogIndex: lastLogIndex(state),
        lastLogTerm: lastLogTerm(state),
      },
    });
  }
  maybeWinElection(state, effects); // single-node cluster wins immediately
  return effects;
}

function onHeartbeatTimeout(state: RaftState): Effect[] {
  if (state.role !== 'leader') return []; // stale timer
  const effects: Effect[] = [];
  broadcastAppendEntries(state, effects);
  return effects;
}

// ---------------------------------------------------------------- messages

function onMessage(state: RaftState, from: NodeId, msg: Message): Effect[] {
  const effects: Effect[] = [];
  if (msg.term > state.currentTerm) {
    const hadPending = state.pendingClientOps.size > 0;
    adoptTerm(state, msg.term, effects);
    if (hadPending) drainPendingAsUnknown(state, effects);
  }
  switch (msg.kind) {
    case 'RequestVote':
      onRequestVote(state, from, msg, effects);
      break;
    case 'RequestVoteReply':
      onRequestVoteReply(state, from, msg, effects);
      break;
    case 'AppendEntries':
      onAppendEntries(state, from, msg, effects);
      break;
    case 'AppendEntriesReply':
      onAppendEntriesReply(state, from, msg, effects);
      break;
  }
  return effects;
}

function onRequestVote(
  state: RaftState,
  from: NodeId,
  msg: Extract<Message, { kind: 'RequestVote' }>,
  effects: Effect[],
): void {
  let granted = false;
  if (msg.term === state.currentTerm) {
    const canVote = state.votedFor === null || state.votedFor === from;
    const upToDate =
      msg.lastLogTerm > lastLogTerm(state) ||
      (msg.lastLogTerm === lastLogTerm(state) && msg.lastLogIndex >= lastLogIndex(state));
    if (canVote && upToDate && state.role === 'follower') {
      granted = true;
      if (state.votedFor === null) {
        state.votedFor = from;
        effects.push({
          type: 'persist',
          hardState: { currentTerm: state.currentTerm, votedFor: state.votedFor },
        });
      }
      // Granting a vote is the one non-AppendEntries event that resets the
      // election timer (Figure 2, followers; Students' Guide trap #1).
      effects.push({ type: 'resetTimer', timer: 'election' });
    }
  }
  effects.push({
    type: 'send',
    to: from,
    msg: { kind: 'RequestVoteReply', term: state.currentTerm, granted },
  });
}

function onRequestVoteReply(
  state: RaftState,
  from: NodeId,
  msg: Extract<Message, { kind: 'RequestVoteReply' }>,
  effects: Effect[],
): void {
  if (state.role !== 'candidate' || msg.term !== state.currentTerm || !msg.granted) return;
  state.votesGranted.add(from);
  maybeWinElection(state, effects);
}

function maybeWinElection(state: RaftState, effects: Effect[]): void {
  if (state.role !== 'candidate' || state.votesGranted.size < quorum(state)) return;
  state.role = 'leader';
  state.leaderId = state.config.id;
  state.votesGranted.clear();
  const next = lastLogIndex(state) + 1;
  for (const peer of state.config.peers) {
    state.nextIndex.set(peer, next);
    state.matchIndex.set(peer, 0);
  }
  // §8: commit an entry from the new term immediately so earlier-term
  // entries become committable (§5.4.2) and reads can be answered.
  const noop: LogEntry = { term: state.currentTerm, cmd: { kind: 'noop' } };
  state.log.push(noop);
  effects.push({ type: 'persist', appendEntries: [noop] });
  effects.push({ type: 'cancelTimer', timer: 'election' });
  broadcastAppendEntries(state, effects);
  tryAdvanceCommit(state, effects); // single-node cluster commits immediately
}

function onAppendEntries(
  state: RaftState,
  from: NodeId,
  msg: Extract<Message, { kind: 'AppendEntries' }>,
  effects: Effect[],
): void {
  if (msg.term < state.currentTerm) {
    effects.push({
      type: 'send',
      to: from,
      msg: {
        kind: 'AppendEntriesReply',
        term: state.currentTerm,
        success: false,
        matchIndex: 0,
        conflictIndex: 0,
      },
    });
    return;
  }

  // msg.term === currentTerm here (greater was adopted in onMessage).
  // A candidate of the same term yields to the elected leader (§5.2).
  if (state.role === 'candidate') becomeFollower(state);
  state.leaderId = from;
  effects.push({ type: 'resetTimer', timer: 'election' });

  // Consistency check (Figure 2, receiver step 2).
  if (msg.prevLogIndex > 0) {
    const prev = entryAt(state, msg.prevLogIndex);
    if (prev === undefined || prev.term !== msg.prevLogTerm) {
      let conflictIndex: LogIndex;
      if (prev === undefined) {
        conflictIndex = lastLogIndex(state) + 1;
      } else {
        conflictIndex = msg.prevLogIndex;
        while (conflictIndex > 1 && entryAt(state, conflictIndex - 1)?.term === prev.term) {
          conflictIndex--;
        }
      }
      effects.push({
        type: 'send',
        to: from,
        msg: {
          kind: 'AppendEntriesReply',
          term: state.currentTerm,
          success: false,
          matchIndex: 0,
          conflictIndex,
        },
      });
      return;
    }
  }

  // Steps 3+4: find the first conflict; truncate there; append the rest.
  // A duplicate or reordered older message must never truncate (§5.3 /
  // Students' Guide): only an actual term conflict deletes entries.
  let firstNew = 0; // offset into msg.entries of the first entry to append
  let truncateFrom: LogIndex | undefined;
  for (; firstNew < msg.entries.length; firstNew++) {
    const index = msg.prevLogIndex + 1 + firstNew;
    const existing = entryAt(state, index);
    if (existing === undefined) break;
    const incoming = msg.entries[firstNew];
    if (incoming !== undefined && existing.term !== incoming.term) {
      truncateFrom = index;
      break;
    }
  }
  const toAppend = msg.entries.slice(firstNew);
  if (truncateFrom !== undefined) {
    state.log.length = truncateFrom - 1;
    if (state.commitIndex >= truncateFrom) {
      /* istanbul ignore next -- a correct leader never truncates committed
         entries; the invariant checker exists to catch it if ours does */
      throw new Error(`truncating committed entry at ${truncateFrom}`);
    }
  }
  if (toAppend.length > 0) state.log.push(...toAppend);
  if (truncateFrom !== undefined || toAppend.length > 0) {
    const persist: Extract<Effect, { type: 'persist' }> = { type: 'persist' };
    if (truncateFrom !== undefined) persist.truncateLogFrom = truncateFrom;
    if (toAppend.length > 0) persist.appendEntries = toAppend;
    effects.push(persist);
  }

  // Step 5: advance commitIndex to min(leaderCommit, last NEW entry).
  const lastNew = msg.prevLogIndex + msg.entries.length;
  if (msg.leaderCommit > state.commitIndex) {
    state.commitIndex = Math.min(msg.leaderCommit, Math.max(lastNew, state.commitIndex));
  }

  effects.push({
    type: 'send',
    to: from,
    msg: {
      kind: 'AppendEntriesReply',
      term: state.currentTerm,
      success: true,
      matchIndex: lastNew,
      conflictIndex: 0,
    },
  });
  emitApplies(state, effects);
}

function onAppendEntriesReply(
  state: RaftState,
  from: NodeId,
  msg: Extract<Message, { kind: 'AppendEntriesReply' }>,
  effects: Effect[],
): void {
  if (state.role !== 'leader' || msg.term !== state.currentTerm) return;
  if (msg.success) {
    const prevMatch = state.matchIndex.get(from) ?? 0;
    if (msg.matchIndex > prevMatch) state.matchIndex.set(from, msg.matchIndex);
    const match = Math.max(prevMatch, msg.matchIndex);
    state.nextIndex.set(from, match + 1);
    tryAdvanceCommit(state, effects);
    return;
  }
  // Rejected on log inconsistency: back up nextIndex (fast hint when given,
  // plain decrement otherwise) and retry immediately. Floor at matchIndex+1:
  // everything through matchIndex is proven replicated, so a stale failure
  // reply must not regress into re-shipping it.
  const current = state.nextIndex.get(from) ?? lastLogIndex(state) + 1;
  const floor = (state.matchIndex.get(from) ?? 0) + 1;
  const backedUp =
    msg.conflictIndex > 0 ? Math.min(msg.conflictIndex, current - 1) : current - 1;
  state.nextIndex.set(from, Math.max(floor, Math.max(1, backedUp)));
  effects.push({ type: 'send', to: from, msg: appendEntriesFor(state, from) });
}

// ---------------------------------------------------------------- clients

function onClientRequest(state: RaftState, cmd: Command, effects: Effect[] = []): Effect[] {
  const opId: OpId | null = cmd.kind === 'noop' ? null : cmd.opId;
  if (state.role !== 'leader') {
    if (opId !== null) {
      const result: ClientResult = { kind: 'notLeader', hint: state.leaderId };
      effects.push({ type: 'clientResult', opId, result });
    }
    return effects;
  }
  const entry: LogEntry = { term: state.currentTerm, cmd };
  state.log.push(entry);
  const index = lastLogIndex(state);
  if (opId !== null) state.pendingClientOps.set(index, opId);
  effects.push({ type: 'persist', appendEntries: [entry] });
  broadcastAppendEntries(state, effects);
  tryAdvanceCommit(state, effects); // single-node cluster commits immediately
  return effects;
}
