// @raftlab/core — sans-IO Raft consensus state machine.
//
// The entire protocol is three pure entry points over caller-owned state:
//   init(config, recovered?)  -> { state, effects }
//   step(state, input)        -> Effect[]   (mutates state in place)
//   cloneState(state)         -> RaftState
//
// The environment owns time, randomness, the network, and storage. It must
// make every persist effect durable before acting on any effect after it in
// the same list, and before feeding the node its next input (ADR-0001).

export * from './types.js';
export { init, step, cloneState, lastLogIndex, lastLogTerm } from './raft.js';

export const CORE_VERSION = '0.1.0';
