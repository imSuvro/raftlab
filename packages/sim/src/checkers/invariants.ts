// Continuous invariant checking per ADR-0003. The CheckerSet observes
// (world, node, effects) after every step and maintains O(1)-amortized
// global bookkeeping for the paper's Figure 3 safety properties. Checkers
// are pure observers: they never mutate sim state and never add trace
// records, so the trace hash is identical with checkers on or off.

import type { Effect, LogEntry, NodeId } from '@raftlab/core';

export class InvariantViolation extends Error {
  constructor(
    readonly invariant:
      | 'ElectionSafety'
      | 'LogMatching'
      | 'LeaderAppendOnly'
      | 'LeaderCompleteness'
      | 'StateMachineSafety'
      | 'Linearizability',
    readonly detail: string,
    readonly eventSeq: number,
  ) {
    super(`${invariant}: ${detail} (eventSeq ${eventSeq})`);
    this.name = 'InvariantViolation';
  }
}

function entryFingerprint(e: LogEntry): string {
  const c = e.cmd;
  if (c.kind === 'noop') return `${e.term}:noop`;
  if (c.kind === 'write') return `${e.term}:w:${c.key}=${c.val}:${c.opId}`;
  return `${e.term}:r:${c.key}:${c.opId}`;
}

/** The slice of per-node state the checkers observe. Structurally satisfied
 *  by the sim's live nodes; tests may drive the CheckerSet with fabricated
 *  sequences through this interface. */
export interface ObservedNode {
  id: NodeId;
  alive: boolean;
  role: string;
  term: number;
  commitIndex: number;
  log: readonly LogEntry[];
}

interface PrevSnapshot {
  role: string;
  term: number;
  logLen: number;
}

export class CheckerSet {
  private readonly leadersByTerm = new Map<number, NodeId>();
  /** "index:term" -> entry fingerprint (Log Matching, incremental). */
  private readonly entriesSeen = new Map<string, string>();
  /** Globally committed prefix, grown monotonically (Leader Completeness). */
  private readonly committedPrefix: string[] = [];
  /** index -> fingerprint of the applied entry (State Machine Safety). */
  private readonly applied = new Map<number, string>();
  private readonly prev = new Map<NodeId, PrevSnapshot>();

  /** Called after every processed step. eventSeq localizes violations. */
  observe(node: ObservedNode, effects: readonly Effect[], eventSeq: number): void {
    const p = this.prev.get(node.id);

    // --- Election Safety: at most one leader per term (Figure 3).
    if (node.role === 'leader' && (p === undefined || p.role !== 'leader' || p.term !== node.term)) {
      const existing = this.leadersByTerm.get(node.term);
      if (existing !== undefined && existing !== node.id) {
        throw new InvariantViolation(
          'ElectionSafety',
          `nodes ${existing} and ${node.id} are both leaders of term ${node.term}`,
          eventSeq,
        );
      }
      this.leadersByTerm.set(node.term, node.id);

      // --- Leader Completeness: the new leader's log must contain every
      // committed entry (Figure 3, checked at the election boundary).
      if (this.committedPrefix.length > node.log.length) {
        throw new InvariantViolation(
          'LeaderCompleteness',
          `leader ${node.id} of term ${node.term} has log length ${node.log.length} < committed prefix ${this.committedPrefix.length}`,
          eventSeq,
        );
      }
      for (let i = 0; i < this.committedPrefix.length; i++) {
        const entry = node.log[i];
        if (entry === undefined || entryFingerprint(entry) !== this.committedPrefix[i]) {
          throw new InvariantViolation(
            'LeaderCompleteness',
            `leader ${node.id} of term ${node.term} diverges from the committed prefix at index ${i + 1}`,
            eventSeq,
          );
        }
      }
    }

    // --- Leader Append-Only: a leader never truncates its own log (Figure 3).
    if (
      p !== undefined &&
      p.role === 'leader' &&
      node.role === 'leader' &&
      p.term === node.term &&
      node.log.length < p.logLen
    ) {
      throw new InvariantViolation(
        'LeaderAppendOnly',
        `leader ${node.id} shrank its log ${p.logLen} -> ${node.log.length} within term ${node.term}`,
        eventSeq,
      );
    }

    // --- Log Matching, incremental: every appended entry either matches
    // what any node ever held at (index, term) or is new; and its
    // predecessor matches the global record (the induction step).
    let appended = 0;
    for (const e of effects) {
      if (e.type === 'persist' && e.appendEntries !== undefined) appended += e.appendEntries.length;
    }
    if (appended > 0) {
      const from = node.log.length - appended + 1;
      for (let idx = from; idx <= node.log.length; idx++) {
        const entry = node.log[idx - 1];
        if (entry === undefined) continue;
        const key = `${idx}:${entry.term}`;
        const fp = entryFingerprint(entry);
        const seen = this.entriesSeen.get(key);
        if (seen !== undefined && seen !== fp) {
          throw new InvariantViolation(
            'LogMatching',
            `two different entries at index ${idx} term ${entry.term}: "${seen}" vs "${fp}" (node ${node.id})`,
            eventSeq,
          );
        }
        this.entriesSeen.set(key, fp);
        const prevEntry = node.log[idx - 2];
        if (idx > 1 && prevEntry !== undefined) {
          const prevKey = `${idx - 1}:${prevEntry.term}`;
          const prevSeen = this.entriesSeen.get(prevKey);
          const prevFp = entryFingerprint(prevEntry);
          if (prevSeen !== undefined && prevSeen !== prevFp) {
            throw new InvariantViolation(
              'LogMatching',
              `entry at index ${idx} (term ${entry.term}) sits on a divergent predecessor at ${idx - 1} (node ${node.id})`,
              eventSeq,
            );
          }
        }
      }
    }

    // --- Committed-prefix growth (feeds Leader Completeness) + commit
    // agreement: overlapping committed ranges must be identical.
    if (node.commitIndex > this.committedPrefix.length) {
      for (let i = 1; i <= node.commitIndex; i++) {
        const entry = node.log[i - 1];
        if (entry === undefined) {
          throw new InvariantViolation(
            'LogMatching',
            `node ${node.id} committed index ${i} beyond its log (${node.log.length})`,
            eventSeq,
          );
        }
        const fp = entryFingerprint(entry);
        const recorded = this.committedPrefix[i - 1];
        if (recorded === undefined) this.committedPrefix[i - 1] = fp;
        else if (recorded !== fp) {
          throw new InvariantViolation(
            'StateMachineSafety',
            `committed entry at index ${i} disagrees across nodes: "${recorded}" vs "${fp}" (node ${node.id})`,
            eventSeq,
          );
        }
      }
    } else if (node.commitIndex > 0) {
      // Spot-check the node's newest committed entry against the record.
      const entry = node.log[node.commitIndex - 1];
      const recorded = this.committedPrefix[node.commitIndex - 1];
      if (entry !== undefined && recorded !== undefined && entryFingerprint(entry) !== recorded) {
        throw new InvariantViolation(
          'StateMachineSafety',
          `node ${node.id} committed prefix diverges at its commitIndex ${node.commitIndex}`,
          eventSeq,
        );
      }
    }

    // --- State Machine Safety: applies at the same index are identical.
    for (const e of effects) {
      if (e.type !== 'apply') continue;
      const entry = node.log[e.index - 1];
      if (entry === undefined) {
        throw new InvariantViolation(
          'StateMachineSafety',
          `node ${node.id} applied index ${e.index} beyond its log`,
          eventSeq,
        );
      }
      const fp = entryFingerprint(entry);
      const seen = this.applied.get(e.index);
      if (seen !== undefined && seen !== fp) {
        throw new InvariantViolation(
          'StateMachineSafety',
          `index ${e.index} applied as "${seen}" and "${fp}" (node ${node.id})`,
          eventSeq,
        );
      }
      if (seen === undefined) this.applied.set(e.index, fp);
    }

    this.prev.set(node.id, { role: node.role, term: node.term, logLen: node.log.length });
  }

  /** Full cross-node Log Matching scan: end-of-run always; every N events
   *  under --paranoid (ADR-0003). O(total log length). */
  fullScan(nodes: readonly ObservedNode[], eventSeq: number): void {
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const A = nodes[a];
        const B = nodes[b];
        if (A === undefined || B === undefined) continue;
        const max = Math.min(A.log.length, B.log.length);
        let anchor = 0;
        for (let i = max; i >= 1; i--) {
          const ea = A.log[i - 1];
          const eb = B.log[i - 1];
          if (ea !== undefined && eb !== undefined && ea.term === eb.term) {
            anchor = i;
            break;
          }
        }
        for (let i = 1; i <= anchor; i++) {
          const ea = A.log[i - 1];
          const eb = B.log[i - 1];
          if (ea === undefined || eb === undefined) continue;
          if (ea.term !== eb.term || entryFingerprint(ea) !== entryFingerprint(eb)) {
            throw new InvariantViolation(
              'LogMatching',
              `nodes ${A.id} and ${B.id} share (index ${anchor}, term) but diverge at index ${i}`,
              eventSeq,
            );
          }
        }
      }
    }
  }
}
