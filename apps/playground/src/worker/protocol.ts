// Worker protocol, frozen in docs/ux.md. The UI is a pure renderer of
// frames; all simulation lives in the worker.

import type { ClusterView, FaultOpSpec, Scenario, UiEvent } from '@raftlab/sim';

export type ToWorker =
  | { t: 'load'; scenario: Scenario }
  | { t: 'play'; speed: number }
  | { t: 'pause' }
  | { t: 'stepOnce' }
  | { t: 'scrubTo'; g: number }
  | { t: 'inject'; op: FaultOpSpec };

export type ToMain =
  | { t: 'frame'; view: ClusterView; logDelta: UiEvent[]; playing: boolean; horizonMs: number }
  | { t: 'scenarioChanged'; scenario: Scenario }
  | { t: 'violation'; invariant: string; detail: string };
