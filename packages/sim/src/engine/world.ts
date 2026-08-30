// The deterministic world: wires @raftlab/core nodes to the scheduler,
// network, storage, clocks, fault script, and client workload. Executes
// effect lists in order, honoring ADR-0001's persistence contract (persist
// folds into SimStorage before any later effect acts; crashes land only
// between events, so durability holds at step granularity by construction).

import {
  init,
  step,
  type Command,
  type DurableState,
  type Effect,
  type Input,
  type LogEntry,
  type NodeId,
  type RaftState,
  type TimerKind,
} from '@raftlab/core';
import type { HistoryEntry } from '../history.js';
import { RAFT_TIMING, type FaultOp, type Scenario, type WorkloadOp } from '../scenario.js';
import { Trace } from '../trace.js';
import { NodeClock, Scheduler, type SimEvent } from './scheduler.js';
import { splitStreams, type RngStreams, type Xoshiro128 } from './rng.js';

class SimStorage {
  hardState = { currentTerm: 0, votedFor: null as NodeId | null };
  log: LogEntry[] = [];

  fold(e: Extract<Effect, { type: 'persist' }>): void {
    if (e.hardState !== undefined) this.hardState = { ...e.hardState };
    if (e.truncateLogFrom !== undefined) this.log.length = e.truncateLogFrom - 1;
    if (e.appendEntries !== undefined) this.log.push(...e.appendEntries);
  }

  read(): DurableState {
    return { ...this.hardState, log: [...this.log] };
  }
}

interface SimNode {
  id: NodeId;
  alive: boolean;
  state: RaftState | null;
  storage: SimStorage;
  clock: NodeClock;
  timerGen: Record<TimerKind, number>;
  /** Volatile KV state machine, rebuilt from apply effects on restart. */
  kv: Map<string, string>;
}

interface ClientState {
  target: NodeId;
}

export interface SimStats {
  events: number;
  deliveries: number;
  dropsRandom: number;
  dropsLink: number;
  dropsDead: number;
  duplicates: number;
  timersFired: number;
  timersStale: number;
  faultsApplied: number;
  clientOpsSent: number;
}

export interface NodeView {
  id: NodeId;
  alive: boolean;
  role: string;
  term: number;
  votedFor: NodeId | null;
  commitIndex: number;
  lastApplied: number;
  logLength: number;
  leaderId: NodeId | null;
}

export interface SimResult {
  hash: number;
  hashHex: string;
  traceRecords: number;
  history: HistoryEntry[];
  stats: SimStats;
  finalView: NodeView[];
  maxCommitIndex: number;
}

export interface WorldOptions {
  /** Retain the last N trace records (failure artifacts / UI). 0 = hash only. */
  keepTraceTail?: number;
}

/** Deterministic workload derivation from the generator spec. The minimizer
 *  calls this same function with the same stream to reify `ops` (ADR-0005). */
export function generateWorkloadOps(scenario: Scenario, workloadRng: Xoshiro128): WorkloadOp[] {
  const spec = scenario.workload;
  if (spec === undefined) return scenario.ops ?? [];
  const ops: WorkloadOp[] = [];
  for (let c = 0; c < spec.clients; c++) {
    for (let i = 0; i < spec.opsPerClient; i++) {
      const slot = Math.floor(((i + 1) * scenario.horizonMs) / (spec.opsPerClient + 1));
      const at = Math.max(0, slot + workloadRng.int(-100, 100));
      const kind = workloadRng.chancePpm(700_000) ? 'write' : 'read';
      const key = `k${workloadRng.int(0, spec.keys - 1)}`;
      const opId = `c${c}-${i}`;
      if (kind === 'write') ops.push({ at, client: c, kind, key, val: `${opId}=v`, opId });
      else ops.push({ at, client: c, kind, key, opId });
    }
  }
  return ops;
}

export class World {
  readonly scenario: Scenario;
  readonly streams: RngStreams;
  readonly sched = new Scheduler();
  readonly trace: Trace;
  readonly nodes: SimNode[];
  readonly stats: SimStats = {
    events: 0, deliveries: 0, dropsRandom: 0, dropsLink: 0, dropsDead: 0,
    duplicates: 0, timersFired: 0, timersStale: 0, faultsApplied: 0, clientOpsSent: 0,
  };
  /** Stage-10 hook: called after every processed step with its effects. */
  afterStep: ((world: World, node: SimNode, ev: SimEvent, effects: Effect[]) => void) | null = null;

  private readonly clients: ClientState[];
  private readonly opsById = new Map<string, HistoryEntry>();
  private readonly historyOrder: HistoryEntry[] = [];
  private readonly readValues = new Map<string, string | null>();
  /** partition group per node (null = fully connected) + directed blocks. */
  private partition: Map<NodeId, number> | null = null;
  private readonly blockedLinks = new Set<string>();

  constructor(scenario: Scenario, opts: WorldOptions = {}) {
    this.scenario = scenario;
    this.streams = splitStreams(scenario.seed >>> 0);
    this.trace = new Trace(opts.keepTraceTail ?? 0);

    const all = Array.from({ length: scenario.nodes }, (_, i) => i);
    this.nodes = all.map((id) => ({
      id,
      alive: true,
      state: null,
      storage: new SimStorage(),
      clock: new NodeClock(),
      timerGen: { election: 0, heartbeat: 0 },
      kv: new Map(),
    }));
    for (const nd of this.nodes) this.bootNode(nd, 0, -1);

    let maxClient = 0;
    for (const op of generateWorkloadOps(scenario, this.streams.workload)) {
      this.sched.push(op.at, { kind: 'client', op });
      maxClient = Math.max(maxClient, op.client + 1);
    }
    this.clients = Array.from({ length: Math.max(1, maxClient) }, (_, c) => ({
      target: c % scenario.nodes,
    }));
    for (const f of scenario.script) this.sched.push(f.at, { kind: 'fault', op: f });
  }

  private config(id: NodeId) {
    return {
      id,
      peers: this.nodes.map((n) => n.id).filter((p) => p !== id),
      electionTimeoutMs: RAFT_TIMING.electionTimeoutMs,
      heartbeatMs: RAFT_TIMING.heartbeatMs,
    };
  }

  private bootNode(nd: SimNode, g: number, seq: number): void {
    const { state, effects } = init(this.config(nd.id), nd.storage.read());
    nd.state = state;
    nd.alive = true;
    nd.kv.clear();
    nd.timerGen.election++;
    nd.timerGen.heartbeat++;
    nd.clock.snapshotAt(g);
    this.executeEffects(nd, effects, g, seq);
  }

  private linkAllows(from: NodeId, to: NodeId): boolean {
    if (this.blockedLinks.has(`${from}>${to}`)) return false;
    if (this.partition === null) return true;
    return this.partition.get(from) === this.partition.get(to);
  }

  // ------------------------------------------------------------- effects

  private executeEffects(nd: SimNode, effects: Effect[], g: number, seq: number): void {
    for (const e of effects) {
      switch (e.type) {
        case 'persist': {
          nd.storage.fold(e);
          const hs = e.hardState ? `hs(${e.hardState.currentTerm},${e.hardState.votedFor ?? '-'})` : '';
          const tr = e.truncateLogFrom !== undefined ? `trunc@${e.truncateLogFrom}` : '';
          const ap = e.appendEntries ? `+${e.appendEntries.length}` : '';
          this.trace.add(g, seq, nd.id, 'fx-persist', `${hs}${tr}${ap}`);
          break;
        }
        case 'send': {
          this.trace.add(g, seq, nd.id, 'fx-send', `${e.msg.kind}>${e.to} t${e.msg.term}`);
          if (this.streams.net.chancePpm(this.scenario.net.dropPpm)) {
            this.stats.dropsRandom++;
            break;
          }
          const copies = this.streams.net.chancePpm(this.scenario.net.dupPpm) ? 2 : 1;
          for (let c = 0; c < copies; c++) {
            const delay = this.streams.net.int(this.scenario.net.delayMs[0], this.scenario.net.delayMs[1]);
            this.sched.push(g + delay, { kind: 'deliver', to: e.to, from: nd.id, msg: e.msg });
          }
          if (copies === 2) this.stats.duplicates++;
          break;
        }
        case 'resetTimer': {
          nd.timerGen[e.timer]++;
          const localNow = nd.clock.localAt(g);
          const delay =
            e.timer === 'election'
              ? this.streams.timer.int(RAFT_TIMING.electionTimeoutMs[0], RAFT_TIMING.electionTimeoutMs[1])
              : RAFT_TIMING.heartbeatMs;
          const dueG = nd.clock.globalAtLocal(localNow + delay, g);
          this.sched.push(dueG, { kind: 'timer', node: nd.id, timer: e.timer, gen: nd.timerGen[e.timer] });
          this.trace.add(g, seq, nd.id, 'fx-timer', `${e.timer}+${delay}`);
          break;
        }
        case 'cancelTimer':
          nd.timerGen[e.timer]++;
          this.trace.add(g, seq, nd.id, 'fx-cancel', e.timer);
          break;
        case 'apply': {
          const cmd = e.cmd;
          if (cmd.kind === 'write') nd.kv.set(cmd.key, cmd.val);
          else if (cmd.kind === 'read') this.readValues.set(cmd.opId, nd.kv.get(cmd.key) ?? null);
          this.trace.add(g, seq, nd.id, 'fx-apply', `${e.index}:${cmd.kind}`);
          break;
        }
        case 'clientResult': {
          this.trace.add(g, seq, nd.id, 'fx-result', `${e.opId}:${e.result.kind}`);
          const entry = this.opsById.get(e.opId);
          if (entry === undefined || entry.returnG !== undefined) break; // already settled
          if (e.result.kind === 'ok') {
            entry.returnG = g;
            entry.outcome = 'ok';
            if (entry.kind === 'read') entry.val = this.readValues.get(e.opId) ?? null;
          } else if (e.result.kind === 'notLeader') {
            entry.returnG = g;
            entry.outcome = 'fail';
            const client = this.clients[entry.clientId];
            if (client !== undefined) {
              client.target =
                e.result.hint !== null && e.result.hint !== nd.id
                  ? e.result.hint
                  : (client.target + 1) % this.scenario.nodes;
            }
          } else {
            // 'unknown': the op may still commit under a later leader. Its
            // return interval stays OPEN (no returnG) per ADR-0004.
            entry.outcome = 'indeterminate';
          }
          break;
        }
      }
    }
  }

  private stepNode(nd: SimNode, input: Input, ev: SimEvent, g: number, seq: number): void {
    if (nd.state === null) return;
    const effects = step(nd.state, input);
    this.executeEffects(nd, effects, g, seq);
    if (this.afterStep !== null) this.afterStep(this, nd, ev, effects);
  }

  // ------------------------------------------------------------- faults

  private applyFault(op: FaultOp, g: number, seq: number): void {
    this.stats.faultsApplied++;
    switch (op.op) {
      case 'partition': {
        this.partition = new Map();
        op.groups.forEach((group, gi) => {
          for (const id of group) this.partition?.set(id, gi);
        });
        // Unlisted nodes share one implicit remainder group.
        for (const nd of this.nodes) {
          if (!this.partition.has(nd.id)) this.partition.set(nd.id, op.groups.length);
        }
        this.trace.add(g, seq, -1, 'fault', `partition ${op.groups.map((x) => x.join(',')).join('|')}`);
        break;
      }
      case 'blockLinks':
        for (const [a, b] of op.links) this.blockedLinks.add(`${a}>${b}`);
        this.trace.add(g, seq, -1, 'fault', `block ${op.links.map(([a, b]) => `${a}>${b}`).join(',')}`);
        break;
      case 'heal':
        this.partition = null;
        this.blockedLinks.clear();
        this.trace.add(g, seq, -1, 'fault', 'heal');
        break;
      case 'crash': {
        const nd = this.nodes[op.node];
        if (nd === undefined || !nd.alive) break;
        nd.alive = false;
        nd.state = null;
        nd.timerGen.election++;
        nd.timerGen.heartbeat++;
        this.trace.add(g, seq, -1, 'fault', `crash ${op.node}`);
        break;
      }
      case 'restart': {
        const nd = this.nodes[op.node];
        if (nd === undefined || nd.alive) break;
        this.trace.add(g, seq, -1, 'fault', `restart ${op.node}`);
        this.bootNode(nd, g, seq);
        break;
      }
      case 'clockSkew': {
        const nd = this.nodes[op.node];
        if (nd === undefined) break;
        nd.clock.skewAt(g, op.offsetMs, op.driftPpm);
        this.trace.add(g, seq, -1, 'fault', `skew ${op.node} ${op.offsetMs}ms ${op.driftPpm}ppm`);
        break;
      }
    }
  }

  private dispatchClient(op: WorkloadOp, g: number, seq: number): void {
    const client = this.clients[op.client];
    if (client === undefined) return;
    let target = this.nodes[client.target];
    for (let tries = 0; tries < this.scenario.nodes && (target === undefined || !target.alive); tries++) {
      client.target = (client.target + 1) % this.scenario.nodes;
      target = this.nodes[client.target];
    }
    if (target === undefined || !target.alive) {
      this.trace.add(g, seq, -1, 'client-skip', op.opId);
      return;
    }
    const cmd: Command =
      op.kind === 'write'
        ? { kind: 'write', key: op.key, val: op.val ?? '', opId: op.opId }
        : { kind: 'read', key: op.key, opId: op.opId };
    const entry: HistoryEntry = {
      opId: op.opId,
      clientId: op.client,
      kind: op.kind,
      key: op.key,
      invokeG: g,
      outcome: 'indeterminate',
    };
    if (op.kind === 'write') entry.val = op.val ?? '';
    this.opsById.set(op.opId, entry);
    this.historyOrder.push(entry);
    this.stats.clientOpsSent++;
    this.trace.add(g, seq, target.id, 'client', `${op.opId} ${op.kind} ${op.key}`);
    this.stepNode(
      target,
      { type: 'clientRequest', cmd, now: target.clock.localAt(g) },
      { kind: 'client', op },
      g,
      seq,
    );
  }

  // ------------------------------------------------------------- main loop

  run(): SimResult {
    for (;;) {
      const entry = this.sched.pop();
      if (entry === undefined || entry.g > this.scenario.horizonMs) break;
      const { g, seq, ev } = entry;
      this.stats.events++;
      switch (ev.kind) {
        case 'deliver': {
          const nd = this.nodes[ev.to];
          if (nd === undefined || !nd.alive) {
            this.stats.dropsDead++;
            break;
          }
          if (!this.linkAllows(ev.from, ev.to)) {
            this.stats.dropsLink++;
            break;
          }
          this.stats.deliveries++;
          this.trace.add(g, seq, ev.to, 'deliver', `${ev.msg.kind}<${ev.from} t${ev.msg.term}`);
          this.stepNode(
            nd,
            { type: 'message', from: ev.from, msg: ev.msg, now: nd.clock.localAt(g) },
            ev,
            g,
            seq,
          );
          break;
        }
        case 'timer': {
          const nd = this.nodes[ev.node];
          if (nd === undefined || !nd.alive || nd.timerGen[ev.timer] !== ev.gen) {
            this.stats.timersStale++;
            break;
          }
          this.stats.timersFired++;
          this.trace.add(g, seq, ev.node, 'timer', ev.timer);
          this.stepNode(nd, { type: 'timeout', timer: ev.timer, now: nd.clock.localAt(g) }, ev, g, seq);
          break;
        }
        case 'fault':
          this.applyFault(ev.op, g, seq);
          break;
        case 'client':
          this.dispatchClient(ev.op, g, seq);
          break;
      }
    }
    return this.result();
  }

  view(): NodeView[] {
    return this.nodes.map((nd) => ({
      id: nd.id,
      alive: nd.alive,
      role: nd.state?.role ?? 'down',
      term: nd.state?.currentTerm ?? nd.storage.hardState.currentTerm,
      votedFor: nd.state?.votedFor ?? nd.storage.hardState.votedFor,
      commitIndex: nd.state?.commitIndex ?? 0,
      lastApplied: nd.state?.lastApplied ?? 0,
      logLength: nd.state?.log.length ?? nd.storage.log.length,
      leaderId: nd.state?.leaderId ?? null,
    }));
  }

  private result(): SimResult {
    return {
      hash: this.trace.hash,
      hashHex: this.trace.hashHex,
      traceRecords: this.trace.records,
      history: [...this.historyOrder],
      stats: { ...this.stats },
      finalView: this.view(),
      maxCommitIndex: Math.max(0, ...this.nodes.map((n) => n.state?.commitIndex ?? 0)),
    };
  }
}
