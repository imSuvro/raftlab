// Trace recording per ADR-0005. Every processed event and effect folds into
// an incremental FNV-1a hash; record objects are retained only when asked
// (event-log UI, failure traceTail) so the fuzz hot path allocates nothing
// per event beyond the record's compact string.

export interface TraceRecord {
  g: number;
  seq: number;
  node: number; // -1 for world-level records (faults)
  kind: string;
  detail: string;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a(str: string, seed: number = FNV_OFFSET): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ str.charCodeAt(i)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

export class Trace {
  private hashAcc = FNV_OFFSET;
  private count = 0;
  private readonly tail: TraceRecord[] | null;
  private readonly tailCap: number;

  /**
   * @param keepTail number of most-recent records to retain (0 = hash only).
   */
  constructor(keepTail = 0) {
    this.tailCap = keepTail;
    this.tail = keepTail > 0 ? [] : null;
  }

  add(g: number, seq: number, node: number, kind: string, detail: string): void {
    this.count++;
    this.hashAcc = fnv1a(`${g}|${seq}|${node}|${kind}|${detail}\n`, this.hashAcc);
    if (this.tail !== null) {
      this.tail.push({ g, seq, node, kind, detail });
      if (this.tail.length > this.tailCap) this.tail.shift();
    }
  }

  get records(): number {
    return this.count;
  }

  get hash(): number {
    return this.hashAcc >>> 0;
  }

  get hashHex(): string {
    return `0x${(this.hashAcc >>> 0).toString(16).padStart(8, '0')}`;
  }

  /** Last N retained records (empty when constructed hash-only). */
  tailRecords(): TraceRecord[] {
    return this.tail === null ? [] : [...this.tail];
  }
}
