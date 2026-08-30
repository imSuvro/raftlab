// The Scenario is the single serializable source of truth (ADR-0002/0005):
// fuzzer output, regression corpus entry, bug-log attachment, and playground
// share-URL payload are all this one shape. Self-contained: v and seed are
// fields of the type; the share URL hoists them into its plaintext prefix.

import type { NodeId } from '@raftlab/core';

export type FaultOp =
  | { at: number; op: 'partition'; groups: NodeId[][] }
  | { at: number; op: 'blockLinks'; links: [from: NodeId, to: NodeId][] }
  | { at: number; op: 'heal' }
  | { at: number; op: 'crash'; node: NodeId }
  | { at: number; op: 'restart'; node: NodeId }
  | { at: number; op: 'clockSkew'; node: NodeId; offsetMs: number; driftPpm: number };

export interface WorkloadOp {
  at: number; // global ms, open-loop
  client: number;
  kind: 'write' | 'read';
  key: string;
  val?: string;
  opId: string;
}

export interface NetProfile {
  delayMs: [min: number, max: number];
  /** Loss probability per message, parts-per-million. */
  dropPpm: number;
  /** Duplication probability per message, parts-per-million. */
  dupPpm: number;
}

export interface WorkloadSpec {
  clients: number;
  opsPerClient: number;
  keys: number;
}

export interface Scenario {
  v: 1;
  seed: number;
  nodes: number;
  horizonMs: number;
  net: NetProfile;
  script: FaultOp[];
  /** Generator spec — the sim derives ops deterministically from workloadRng. */
  workload?: WorkloadSpec;
  /** Reified op list — takes precedence over workload when present
   *  (the minimizer reifies on first run; exactly one of the two is set). */
  ops?: WorkloadOp[];
}

export const RAFT_TIMING = {
  electionTimeoutMs: [150, 300] as [number, number],
  heartbeatMs: 50,
};

export function defaultScenario(seed: number, overrides: Partial<Scenario> = {}): Scenario {
  return {
    v: 1,
    seed,
    nodes: 5,
    horizonMs: 60_000,
    net: { delayMs: [5, 40], dropPpm: 0, dupPpm: 0 },
    script: [],
    workload: { clients: 3, opsPerClient: 40, keys: 5 },
    ...overrides,
  };
}

export function validateScenario(s: Scenario): void {
  const fail = (msg: string): never => {
    throw new Error(`invalid scenario: ${msg}`);
  };
  if (s.v !== 1) fail(`unknown version ${String(s.v)}`);
  if (!Number.isInteger(s.seed)) fail('seed must be an integer');
  if (!Number.isInteger(s.nodes) || s.nodes < 1 || s.nodes > 25) fail('nodes out of range');
  if (!Number.isInteger(s.horizonMs) || s.horizonMs <= 0) fail('horizonMs must be a positive integer');
  const [lo, hi] = s.net.delayMs;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) fail('net.delayMs malformed');
  if (s.net.dropPpm < 0 || s.net.dropPpm > 1_000_000) fail('net.dropPpm out of range');
  if (s.net.dupPpm < 0 || s.net.dupPpm > 1_000_000) fail('net.dupPpm out of range');
  if ((s.workload === undefined) === (s.ops === undefined)) {
    fail('exactly one of workload (generator spec) or ops (reified list) must be set');
  }
  for (const f of s.script) {
    if (!Number.isInteger(f.at) || f.at < 0) fail(`fault at ${String(f.at)} not a non-negative integer`);
    switch (f.op) {
      case 'partition': {
        const seen = new Set<NodeId>();
        for (const group of f.groups) {
          for (const id of group) {
            if (!Number.isInteger(id) || id < 0 || id >= s.nodes) fail(`partition names unknown node ${id}`);
            if (seen.has(id)) fail(`partition lists node ${id} twice`);
            seen.add(id);
          }
        }
        break;
      }
      case 'blockLinks':
        for (const [a, b] of f.links) {
          if (a < 0 || a >= s.nodes || b < 0 || b >= s.nodes) fail('blockLinks names unknown node');
        }
        break;
      case 'crash':
      case 'restart':
        if (f.node < 0 || f.node >= s.nodes) fail(`${f.op} names unknown node ${f.node}`);
        break;
      case 'clockSkew':
        if (f.node < 0 || f.node >= s.nodes) fail(`clockSkew names unknown node ${f.node}`);
        if (!Number.isInteger(f.offsetMs) || !Number.isInteger(f.driftPpm)) {
          fail('clockSkew offsetMs/driftPpm must be integers (no float time math)');
        }
        break;
      case 'heal':
        break;
    }
  }
  if (s.ops) {
    const ids = new Set<string>();
    for (const op of s.ops) {
      if (!Number.isInteger(op.at) || op.at < 0) fail('workload op time malformed');
      if (ids.has(op.opId)) fail(`duplicate opId ${op.opId}`);
      ids.add(op.opId);
      if (op.kind === 'write' && op.val === undefined) fail(`write ${op.opId} missing val`);
    }
  }
}

/** JSON round-trip (used by the fuzz CLI, regression corpus, and URL codec). */
export function serializeScenario(s: Scenario): string {
  return JSON.stringify(s);
}

export function parseScenario(json: string): Scenario {
  const s = JSON.parse(json) as Scenario;
  validateScenario(s);
  return s;
}
