import type { ClusterView, FaultOpSpec, Scenario, UiEvent } from '@raftlab/sim';
import { create } from 'zustand';
import type { ToMain, ToWorker } from './worker/protocol.js';
import { encodeScenario } from './url.js';

export interface PlaygroundState {
  scenario: Scenario | null;
  view: ClusterView | null;
  events: UiEvent[];
  narrator: string;
  playing: boolean;
  speed: number;
  horizonMs: number;
  violation: { invariant: string; detail: string } | null;
  toast: string | null;
  hintDismissed: boolean;
  send: (msg: ToWorker) => void;
  onMessage: (msg: ToMain) => void;
  setToast: (text: string | null) => void;
  dismissHint: () => void;
  inject: (op: FaultOpSpec) => void;
  share: () => void;
}

let worker: Worker | null = null;

export function attachWorker(w: Worker): void {
  worker = w;
  w.onmessage = (e: MessageEvent<ToMain>) => {
    useStore.getState().onMessage(e.data);
  };
}

const HINT_KEY = 'raftlab.hintSeen';

function hintAlreadySeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false; // private windows, blocked storage — show the hint
  }
}

export const useStore = create<PlaygroundState>((set, get) => ({
  scenario: null,
  view: null,
  events: [],
  narrator: 'Starting a five-node cluster…',
  playing: true,
  speed: 1,
  horizonMs: 600_000,
  violation: null,
  toast: null,
  hintDismissed: hintAlreadySeen(),

  send: (msg) => worker?.postMessage(msg),

  onMessage: (msg) => {
    if (msg.t === 'frame') {
      const prev = get().events;
      const events = msg.logDelta.length > 0 ? [...prev, ...msg.logDelta].slice(-300) : prev;
      const narrated = [...msg.logDelta].reverse().find((e) => e.narratorLine !== undefined);
      set({
        view: msg.view,
        events,
        playing: msg.playing,
        horizonMs: msg.horizonMs,
        ...(narrated?.narratorLine !== undefined ? { narrator: narrated.narratorLine } : {}),
      });
    } else if (msg.t === 'scenarioChanged') {
      set({ scenario: msg.scenario });
      void encodeScenario(msg.scenario).then((hash) => {
        history.replaceState(null, '', hash);
      });
    } else if (msg.t === 'violation') {
      set({
        violation: { invariant: msg.invariant, detail: msg.detail },
        narrator: `Invariant violated: ${msg.invariant}. This run is a bug report.`,
      });
    }
  },

  setToast: (text) => set({ toast: text }),

  dismissHint: () => {
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // storage unavailable; the hint simply returns next visit
    }
    set({ hintDismissed: true });
  },

  inject: (op) => get().send({ t: 'inject', op }),

  share: () => {
    const scenario = get().scenario;
    if (scenario === null) return;
    void encodeScenario(scenario).then(async (hash) => {
      const url = `${location.origin}${location.pathname}${hash}`;
      try {
        await navigator.clipboard.writeText(url);
        get().setToast('Link copied — it replays this exact run, faults included.');
      } catch {
        history.replaceState(null, '', hash);
        get().setToast('Link is in the address bar — copy it to share this run.');
      }
    });
  },
}));
