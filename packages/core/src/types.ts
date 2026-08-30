// The frozen vocabulary of ADR-0001. Everything that crosses the core
// boundary is defined here; packages/sim and the playground compile against
// these types and nothing else.

export type NodeId = number; // 0..n-1
export type Term = number;
export type LogIndex = number; // 1-based; 0 means "none"
export type OpId = string; // unique per client operation, assigned by the client

export interface RaftConfig {
  id: NodeId;
  /** Peer ids, excluding self. Order is normalized (sorted) by init(). */
  peers: NodeId[];
  /** [min, max] election timeout range; the environment draws the jitter. */
  electionTimeoutMs: [min: number, max: number];
  heartbeatMs: number;
}

export type Command =
  | { kind: 'noop' }
  | { kind: 'write'; key: string; val: string; opId: OpId }
  | { kind: 'read'; key: string; opId: OpId };

/** Log entries are immutable once created; holders may share references. */
export interface LogEntry {
  term: Term;
  cmd: Command;
}

/** What must survive a crash, exactly as the paper's Figure 2 requires. */
export interface HardState {
  currentTerm: Term;
  votedFor: NodeId | null;
}

export interface DurableState extends HardState {
  log: LogEntry[];
}

export type Role = 'follower' | 'candidate' | 'leader';

export type TimerKind = 'election' | 'heartbeat';

export type Message =
  | { kind: 'RequestVote'; term: Term; lastLogIndex: LogIndex; lastLogTerm: Term }
  | { kind: 'RequestVoteReply'; term: Term; granted: boolean }
  | {
      kind: 'AppendEntries';
      term: Term;
      prevLogIndex: LogIndex;
      prevLogTerm: Term;
      entries: LogEntry[];
      leaderCommit: LogIndex;
    }
  | {
      kind: 'AppendEntriesReply';
      term: Term;
      success: boolean;
      /** On success: last index known replicated on the sender (idempotent ack). */
      matchIndex: LogIndex;
      /** On failure: fast-backup hint — first index of the conflicting term,
       *  or (own log length + 1) when the log is too short. 0 when unused. */
      conflictIndex: LogIndex;
    };

export type Input =
  | { type: 'message'; from: NodeId; msg: Message; now: number }
  | { type: 'timeout'; timer: TimerKind; now: number }
  | { type: 'clientRequest'; cmd: Command; now: number };

export type ClientResult =
  | { kind: 'ok' } // the environment derives read values by applying commands in order
  | { kind: 'notLeader'; hint: NodeId | null }
  | { kind: 'unknown' }; // indeterminate: may or may not commit later

export type Effect =
  | {
      type: 'persist';
      hardState?: HardState;
      /** Entries to append durably, in order, after any truncation. */
      appendEntries?: LogEntry[];
      /** Truncate the durable log from this index (inclusive) before appending. */
      truncateLogFrom?: LogIndex;
    }
  | { type: 'send'; to: NodeId; msg: Message }
  | { type: 'resetTimer'; timer: TimerKind }
  | { type: 'cancelTimer'; timer: TimerKind }
  | { type: 'apply'; index: LogIndex; cmd: Command }
  | { type: 'clientResult'; opId: OpId; result: ClientResult };

export interface RaftState {
  readonly config: RaftConfig;

  // Durable fields (mirrored here; the environment persists via effects).
  currentTerm: Term;
  votedFor: NodeId | null;
  log: LogEntry[];

  // Volatile.
  role: Role;
  commitIndex: LogIndex;
  lastApplied: LogIndex;
  /** Last known leader of currentTerm, for notLeader hints. */
  leaderId: NodeId | null;

  // Candidate-only (empty otherwise).
  votesGranted: Set<NodeId>;

  // Leader-only (empty otherwise). Keyed by peer id, insertion in peer order.
  nextIndex: Map<NodeId, LogIndex>;
  matchIndex: Map<NodeId, LogIndex>;
  /** Client ops awaiting commit on this leader: log index -> opId. */
  pendingClientOps: Map<LogIndex, OpId>;
}
