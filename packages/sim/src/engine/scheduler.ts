// Virtual-time event scheduler per ADR-0002: a binary min-heap ordered by
// the total order (dueAtGlobal, seq). seq is a monotone insertion counter,
// so ties break deterministically and identical seeds give byte-identical
// event sequences. All times are integer milliseconds.

import type { Message, NodeId, TimerKind } from '@raftlab/core';
import type { FaultOp, WorkloadOp } from '../scenario.js';

export type SimEvent =
  | { kind: 'deliver'; to: NodeId; from: NodeId; msg: Message }
  | { kind: 'timer'; node: NodeId; timer: TimerKind; gen: number }
  | { kind: 'fault'; op: FaultOp }
  | { kind: 'client'; op: WorkloadOp };

interface HeapEntry {
  g: number; // global virtual time, integer ms
  seq: number;
  ev: SimEvent;
}

function before(a: HeapEntry, b: HeapEntry): boolean {
  return a.g < b.g || (a.g === b.g && a.seq < b.seq);
}

export class Scheduler {
  private readonly heap: HeapEntry[] = [];
  private seq = 0;
  /** Global virtual now: the g of the most recently popped event. */
  now = 0;

  get size(): number {
    return this.heap.length;
  }

  push(g: number, ev: SimEvent): void {
    if (!Number.isInteger(g)) throw new Error(`non-integer schedule time ${g}`);
    const entry: HeapEntry = { g: Math.max(g, this.now), seq: this.seq++, ev };
    const a = this.heap;
    a.push(entry);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const parent = a[p] as HeapEntry;
      if (before(parent, entry)) break;
      a[i] = parent;
      i = p;
    }
    a[i] = entry;
  }

  pop(): HeapEntry | undefined {
    const a = this.heap;
    const top = a[0];
    if (top === undefined) return undefined;
    const last = a.pop() as HeapEntry;
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mv = last;
        const le = a[l];
        if (le !== undefined && before(le, mv)) {
          m = l;
          mv = le;
        }
        const re = a[r];
        if (re !== undefined && before(re, mv)) {
          m = r;
        }
        if (m === i) break;
        a[i] = a[m] as HeapEntry;
        i = m;
      }
      a[i] = last;
    }
    this.now = top.g;
    return top;
  }
}

/**
 * Per-node clock mapping between global virtual time and the node's local
 * clock, with skew (offset jump) and drift (rate change, parts-per-million).
 * In the API from the first commit per ADR-0002, even while offset=0/ppm=0.
 *
 * local(g) = baseLocal + floor((g - baseG) * (1e6 + driftPpm) / 1e6)
 */
export class NodeClock {
  private baseG = 0;
  private baseLocal = 0;
  private driftPpm = 0;

  localAt(g: number): number {
    const elapsed = g - this.baseG;
    return this.baseLocal + Math.floor((elapsed * (1_000_000 + this.driftPpm)) / 1_000_000);
  }

  /** Least global g ≥ fromG at which the local clock reads ≥ targetLocal. */
  globalAtLocal(targetLocal: number, fromG: number): number {
    const rate = 1_000_000 + this.driftPpm;
    const needed = targetLocal - this.baseLocal;
    // Smallest elapsed with floor(elapsed * rate / 1e6) >= needed:
    let elapsed = Math.ceil((needed * 1_000_000) / rate);
    while (Math.floor((elapsed * rate) / 1_000_000) < needed) elapsed++;
    while (elapsed > 0 && Math.floor(((elapsed - 1) * rate) / 1_000_000) >= needed) elapsed--;
    return Math.max(this.baseG + elapsed, fromG);
  }

  /** Apply a skew fault at global time g: jump the local clock by offsetMs
   *  (either direction) and continue at the new drift rate. Note: under
   *  timer-intent semantics (delays armed relative to the current local
   *  reading, ADR-0001) an offset jump alone is nearly unobservable —
   *  already-armed timers keep their global due times and future arms are
   *  relative. Drift is the operative skew fault: it stretches/compresses
   *  every subsequent election and heartbeat delay on this node. */
  skewAt(g: number, offsetMs: number, driftPpm: number): void {
    const current = this.localAt(g);
    this.baseG = g;
    this.baseLocal = current + offsetMs;
    this.driftPpm = driftPpm;
  }

  /** Reset on restart: the local clock of a fresh incarnation resumes from
   *  its current reading (monotone), drift retained. */
  snapshotAt(g: number): void {
    const current = this.localAt(g);
    this.baseG = g;
    this.baseLocal = current;
  }
}
