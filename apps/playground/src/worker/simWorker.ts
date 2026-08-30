/// <reference lib="webworker" />
// The simulation loop. Runs @raftlab/sim unchanged — the same engine the
// fuzz campaign drives — so anything visible here is reproducible from the
// scenario alone.
//
// Two rules keep the session deterministic:
//   1. Live fault injection appends a time-stamped op to scenario.script,
//      so the session stays a pure function of (seed, script).
//   2. Scrubbing re-runs from t=0 (measured ~1ms per 60 virtual seconds in
//      the stage-3 spike), so history is never approximated.

import { InvariantViolation, World, type Scenario, type UiEvent } from '@raftlab/sim';
import type { ToMain, ToWorker } from './protocol.js';

const FRAME_MS = 33; // ~30 Hz
const WORLD_OPTS = { collectEvents: true, checkers: true } as const;

let scenario: Scenario | null = null;
let world: World | null = null;
let playing = false;
let speed = 1;
let eventsSent = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let violated = false;

function post(msg: ToMain): void {
  (self as unknown as Worker).postMessage(msg);
}

function build(target: Scenario): World {
  const w = new World(target, WORLD_OPTS);
  eventsSent = 0;
  violated = false;
  return w;
}

/** Advance to a target virtual time, converting an invariant violation into
 *  a message instead of killing the worker (ADR-0003 note in docs/ux.md). */
function advanceTo(targetG: number): void {
  if (world === null || violated) return;
  try {
    world.runUntil(targetG);
  } catch (err) {
    violated = true;
    playing = false;
    if (err instanceof InvariantViolation) {
      post({ t: 'violation', invariant: err.invariant, detail: err.detail });
    } else {
      post({ t: 'violation', invariant: 'Error', detail: String(err) });
    }
  }
}

function sendFrame(): void {
  if (world === null || scenario === null) return;
  const all: UiEvent[] = world.events;
  const delta = all.slice(eventsSent);
  eventsSent = all.length;
  post({
    t: 'frame',
    view: world.clusterView(),
    logDelta: delta,
    playing,
    horizonMs: scenario.horizonMs,
  });
}

function tick(): void {
  if (world === null || scenario === null) return;
  if (playing && !violated) {
    const target = Math.min(world.sched.now + Math.round(FRAME_MS * speed), scenario.horizonMs);
    advanceTo(target);
    if (world.sched.now >= scenario.horizonMs) playing = false;
  }
  sendFrame();
}

function startLoop(): void {
  if (timer !== null) return;
  timer = setInterval(tick, FRAME_MS);
}

self.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data;
  switch (msg.t) {
    case 'load':
      scenario = structuredClone(msg.scenario);
      world = build(scenario);
      playing = true;
      startLoop();
      sendFrame();
      break;
    case 'play':
      speed = msg.speed;
      if (!violated) playing = true;
      break;
    case 'pause':
      playing = false;
      sendFrame();
      break;
    case 'stepOnce':
      if (world !== null && !violated) {
        playing = false;
        try {
          world.stepOnce();
        } catch (err) {
          violated = true;
          post({
            t: 'violation',
            invariant: err instanceof InvariantViolation ? err.invariant : 'Error',
            detail: err instanceof InvariantViolation ? err.detail : String(err),
          });
        }
        sendFrame();
      }
      break;
    case 'scrubTo': {
      // Re-run from t=0: the only honest way to move backwards through a
      // deterministic history, and fast enough to do inside one frame.
      if (scenario === null) break;
      const wasPlaying = playing;
      playing = false;
      world = build(scenario);
      advanceTo(msg.g);
      playing = wasPlaying && !violated;
      sendFrame();
      break;
    }
    case 'inject': {
      if (world === null || scenario === null) break;
      world.injectFault(msg.op);
      // world.scenario is the same object the world mutates; mirror it out
      // so the share URL always matches what the visitor is looking at.
      scenario = { ...scenario, script: [...world.scenario.script] };
      post({ t: 'scenarioChanged', scenario });
      sendFrame();
      break;
    }
  }
};
