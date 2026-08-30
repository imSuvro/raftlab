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
import { CheckerSet, type ObservedNode } from '../checkers/invariants.js';
import { checkLinearizability } from '../checkers/linearizability.js';
import type { HistoryEntry } from '../history.js';
import {
  RAFT_TIMING,
  type FaultOp,
  type FaultOpSpec,
  type Scenario,
  type WorkloadOp,
} from '../scenario.js';
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

/** The playground's frame payload (docs/ux.md data contract). */
export interface ClusterView {
  g: number;
  nodes: Array<
    NodeView & {
      logWindow: Array<{ index: number; term: number }>;
      clockOffsetMs: number;
    }
  >;
  inflight: Array<{ from: NodeId; to: NodeId; kind: string; sendG: number; deliverG: number }>;
  partitions: NodeId[][] | null;
  leaderId: NodeId | null;
}

export interface UiEvent {
  g: number;
  kind: 'election' | 'append' | 'commit' | 'fault' | 'client';
  summary: string;
  /** Plain-English line for the narrator caption, when this event deserves one. */
  narratorLine?: string;
}

export interface SimResult {
  hash: number;
  hashHex: string;
  traceRecords: number;
  history: HistoryEntry[];
  stats: SimStats;
  finalView: NodeView[];
  maxCommitIndex: number;
  linearizability?: { keysChecked: number; opsChecked: number };
}

export interface WorldOptions {
  /** Retain the last N trace records (failure artifacts / UI). 0 = hash only. */
  keepTraceTail?: number;
  /** Collect the human-readable, narrated event log (playground). Off by
   *  default so the fuzz hot path allocates nothing extra. */
  collectEvents?: boolean;
  /** Continuous invariant + end-of-run linearizability checking (default on). */
  checkers?: boolean;
  /** Run the full cross-node log-matching scan every N events (nightly
   *  --paranoid tier, ADR-0003). 0 = end-of-run only. */
  paranoidEveryEvents?: number;
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
  /** Hook for observers (playground narration): after every processed step. */
  afterStep: ((world: World, node: SimNode, ev: SimEvent, effects: Effect[]) => void) | null = null;
  private readonly checkers: CheckerSet | null;
  private readonly paranoidEvery: number;
  private readonly collectEvents: boolean;
  /** Narrated event log (playground only; empty unless collectEvents). */
  readonly events: UiEvent[] = [];

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
    this.checkers = (opts.checkers ?? true) ? new CheckerSet() : null;
    this.paranoidEvery = opts.paranoidEveryEvents ?? 0;
    this.collectEvents = opts.collectEvents ?? false;

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
            this.sched.push(g + delay, { kind: 'deliver', to: e.to, from: nd.id, msg: e.msg, sendG: g });
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

  private observed(nd: SimNode): ObservedNode {
    return {
      id: nd.id,
      alive: nd.alive,
      role: nd.state?.role ?? 'down',
      term: nd.state?.currentTerm ?? 0,
      commitIndex: nd.state?.commitIndex ?? 0,
      log: nd.state?.log ?? nd.storage.log,
    };
  }

  private stepNode(nd: SimNode, input: Input, ev: SimEvent, g: number, seq: number): void {
    if (nd.state === null) return;
    const before = this.collectEvents
      ? { role: nd.state.role, term: nd.state.currentTerm, commit: nd.state.commitIndex }
      : null;
    const effects = step(nd.state, input);
    this.executeEffects(nd, effects, g, seq);
    if (this.checkers !== null) this.checkers.observe(this.observed(nd), effects, this.trace.records);
    if (before !== null && nd.state !== null) this.narrate(nd, before, g);
    if (this.afterStep !== null) this.afterStep(this, nd, ev, effects);
  }

  /** Turn a step's state delta into event-log entries and narrator lines. */
  private narrate(
    nd: SimNode,
    before: { role: string; term: number; commit: number },
    g: number,
  ): void {
    const s = nd.state;
    if (s === null) return;
    const n = nd.id + 1; // humans count from 1
    if (s.role !== before.role) {
      if (s.role === 'candidate') {
        this.pushEvent({
          g,
          kind: 'election',
          summary: `N${n} election timeout — RequestVote(t${s.currentTerm})`,
          narratorLine: `Node ${n}'s election timer fired — it's asking for votes (term ${s.currentTerm}).`,
        });
      } else if (s.role === 'leader') {
        const quorum = Math.floor(this.scenario.nodes / 2) + 1;
        this.pushEvent({
          g,
          kind: 'election',
          summary: `N${n} wins election t${s.currentTerm}`,
          narratorLine: `Node ${n} won the election with at least ${quorum} votes. Term ${s.currentTerm} has a leader.`,
        });
      } else if (before.role === 'leader') {
        this.pushEvent({
          g,
          kind: 'election',
          summary: `N${n} steps down (t${s.currentTerm})`,
          narratorLine: `Node ${n} is no longer the leader — a higher term appeared.`,
        });
      }
    }
    if (s.commitIndex > before.commit) {
      this.pushEvent({ g, kind: 'commit', summary: `N${n} commitIndex → ${s.commitIndex}` });
    }
  }

  private pushEvent(e: UiEvent): void {
    this.events.push(e);
    if (this.events.length > 400) this.events.shift();
  }

  // ------------------------------------------------------------- faults

  private narrateFault(op: FaultOp, g: number): void {
    if (!this.collectEvents) return;
    const n = (id: NodeId): number => id + 1;
    switch (op.op) {
      case 'partition':
        this.pushEvent({
          g,
          kind: 'fault',
          summary: `partition ${op.groups.map((grp) => grp.map(n).join(',')).join(' | ')}`,
          narratorLine: `The network is split ${op.groups.map((grp) => grp.length).join(' | ')}. The minority side can't commit.`,
        });
        break;
      case 'blockLinks':
        this.pushEvent({
          g,
          kind: 'fault',
          summary: `block ${op.links.map(([a, b]) => `N${n(a)}→N${n(b)}`).join(', ')}`,
          narratorLine: 'Some one-way links are broken. Messages get through in only one direction.',
        });
        break;
      case 'heal':
        this.pushEvent({
          g,
          kind: 'fault',
          summary: 'heal network',
          narratorLine: 'Network healed. Divergent entries get overwritten by the leader’s log.',
        });
        break;
      case 'crash':
        this.pushEvent({
          g,
          kind: 'fault',
          summary: `kill N${n(op.node)}`,
          narratorLine: `Node ${n(op.node)} went down. The others will notice when heartbeats stop.`,
        });
        break;
      case 'restart':
        this.pushEvent({
          g,
          kind: 'fault',
          summary: `restart N${n(op.node)}`,
          narratorLine: `Node ${n(op.node)} is back. It follows the current leader and catches up.`,
        });
        break;
      case 'clockSkew':
        this.pushEvent({
          g,
          kind: 'fault',
          summary: `skew N${n(op.node)} ${op.offsetMs}ms ${op.driftPpm}ppm`,
          narratorLine: `Node ${n(op.node)}'s clock now runs at a different rate. Its timers drift out of step.`,
        });
        break;
    }
  }

  private applyFault(op: FaultOp, g: number, seq: number): void {
    this.stats.faultsApplied++;
    this.narrateFault(op, g);
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

  /**
   * Process events while the next one is due at or before `targetG`.
   * The playground's frame loop drives the world in slices this way; run()
   * is the same loop with the horizon as the target.
   * Returns false when the world is idle (no pending events).
   */
  runUntil(targetG: number): boolean {
    const limit = Math.min(targetG, this.scenario.horizonMs);
    for (;;) {
      const nextG = this.sched.peekG();
      if (nextG === undefined || nextG > limit) {
        // Nothing is due before `limit`, so virtual time genuinely passed:
        // advance the clock, or the playground's frame loop would ask for
        // the same window forever and never move.
        this.sched.idleAdvanceTo(limit);
        return nextG !== undefined;
      }
      this.processNext();
    }
  }

  /** Process exactly one event (the transport bar's step button). */
  stepOnce(): boolean {
    if (this.sched.peekG() === undefined) return false;
    this.processNext();
    return true;
  }

  /** Append a fault at the current virtual time (live injection). Keeps the
   *  session a pure function of (seed, script): scrubbing replays it. */
  injectFault(op: FaultOpSpec): FaultOp {
    const stamped = { ...op, at: this.sched.now } as FaultOp;
    this.scenario.script.push(stamped);
    this.sched.push(stamped.at, { kind: 'fault', op: stamped });
    return stamped;
  }

  private processNext(): void {
    const entry = this.sched.pop();
    if (entry === undefined) return;
    const { g, seq, ev } = entry;
    this.stats.events++;
    this.dispatch(ev, g, seq);
    if (
      this.checkers !== null &&
      this.paranoidEvery > 0 &&
      this.stats.events % this.paranoidEvery === 0
    ) {
      this.checkers.fullScan(this.nodes.map((n) => this.observed(n)), this.trace.records);
    }
  }

  /** Route one popped event to its handler. Shared by run() and the
   *  playground's incremental runUntil()/stepOnce(). */
  private dispatch(ev: SimEvent, g: number, seq: number): void {
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

  run(): SimResult {
    for (;;) {
      const nextG = this.sched.peekG();
      if (nextG === undefined || nextG > this.scenario.horizonMs) break;
      this.processNext();
    }
    let linearizability: { keysChecked: number; opsChecked: number } | undefined;
    if (this.checkers !== null) {
      this.checkers.fullScan(this.nodes.map((n) => this.observed(n)), this.trace.records);
      const report = checkLinearizability(this.historyOrder, this.trace.records);
      linearizability = { keysChecked: report.keysChecked, opsChecked: report.opsChecked };
    }
    return this.result(linearizability);
  }

  /** Frame payload for the playground (docs/ux.md data contract). */
  clusterView(logWindowSize = 30): ClusterView {
    const leader = this.nodes.find((nd) => nd.alive && nd.state?.role === 'leader');
    const inflight: ClusterView['inflight'] = [];
    for (const entry of this.sched.pending()) {
      if (entry.ev.kind !== 'deliver') continue;
      const { from, to, msg, sendG } = entry.ev;
      if (!this.linkAllows(from, to)) continue; // a blocked message never appears in flight
      if (this.nodes[to]?.alive !== true) continue;
      inflight.push({ from, to, kind: msg.kind, sendG, deliverG: entry.g });
    }
    const partitions: NodeId[][] | null =
      this.partition === null
        ? null
        : [...new Set(this.partition.values())]
            .sort((a, b) => a - b)
            .map((grp) => this.nodes.filter((nd) => this.partition?.get(nd.id) === grp).map((nd) => nd.id));
    return {
      g: this.sched.now,
      nodes: this.view().map((nv) => {
        const nd = this.nodes[nv.id];
        const log = nd?.state?.log ?? nd?.storage.log ?? [];
        const start = Math.max(0, log.length - logWindowSize);
        return {
          ...nv,
          logWindow: log.slice(start).map((e, i) => ({ index: start + i + 1, term: e.term })),
          clockOffsetMs: nd === undefined ? 0 : nd.clock.localAt(this.sched.now) - this.sched.now,
        };
      }),
      inflight,
      partitions,
      leaderId: leader?.id ?? null,
    };
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

  private result(linearizability?: { keysChecked: number; opsChecked: number }): SimResult {
    const r: SimResult = {
      hash: this.trace.hash,
      hashHex: this.trace.hashHex,
      traceRecords: this.trace.records,
      history: [...this.historyOrder],
      stats: { ...this.stats },
      finalView: this.view(),
      maxCommitIndex: Math.max(0, ...this.nodes.map((n) => n.state?.commitIndex ?? 0)),
    };
    if (linearizability !== undefined) r.linearizability = linearizability;
    return r;
  }
}
