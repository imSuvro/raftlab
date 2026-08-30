// Client-operation history per ADR-0004 — frozen at stage 5. The stage-10
// linearizability checker consumes exactly this shape.

export interface HistoryEntry {
  opId: string;
  clientId: number;
  kind: 'read' | 'write';
  key: string;
  /** For writes: the written value. For reads: the value returned at apply
   *  time (null = key absent); undefined until/unless the read completes. */
  val?: string | null;
  invokeG: number;
  returnG?: number;
  /** ok = committed and acknowledged; fail = notLeader (never entered the
   *  log; never linearizes); indeterminate = open return interval — the
   *  checker may linearize it at any point after invokeG, or never. */
  outcome: 'ok' | 'fail' | 'indeterminate';
}
