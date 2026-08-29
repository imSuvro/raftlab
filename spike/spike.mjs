// Stage-3 feasibility spike. THROWAWAY — deleted at the stage-7 scaffold.
// Questions answered:
//   (a) events/sec of a (time, seq)-ordered binary-heap event loop in V8
//   (b) identical seed -> byte-identical serialized event trace, 10 runs
//   (c) structuredClone cost of a playground-frame-sized view model at 30 Hz
// Protocol under test is a trivial echo: N nodes, each timer tick sends a
// ping to a random peer; receiver replies pong; delays are drawn from the
// seeded PRNG. No Raft here — this only exercises scheduler + RNG + trace.

// ---------- seeded PRNG: splitmix32 (seeding) + xoshiro128** (stream) ----------

function splitmix32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

class Xoshiro128ss {
  constructor(seed) {
    const sm = splitmix32(seed);
    this.s0 = sm(); this.s1 = sm(); this.s2 = sm(); this.s3 = sm();
  }
  nextU32() {
    const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9)) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }
  int(lo, hi) { return lo + (this.nextU32() % (hi - lo + 1)); } // spike-grade; modulo bias irrelevant here
}

// ---------- binary min-heap ordered by (time, seq) ----------

class EventHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(ev) {
    const a = this.a; a.push(ev);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t < ev.t || (a[p].t === ev.t && a[p].seq < ev.seq)) break;
      a[i] = a[p]; i = p;
    }
    a[i] = ev;
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i, mv = last;
      if (l < a.length && (a[l].t < mv.t || (a[l].t === mv.t && a[l].seq < mv.seq))) { m = l; mv = a[l]; }
      if (r < a.length && (a[r].t < mv.t || (a[r].t === mv.t && a[r].seq < mv.seq))) { m = r; }
      if (m === i) break;
      a[i] = a[m]; i = m;
    }
    a[i] = last;
    return top;
  }
}

// ---------- FNV-1a over a string ----------

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ str.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------- the echo simulation ----------

function runEcho(seed, { nodes = 5, horizon = 60_000, tickMs = 50, trace = true } = {}) {
  const rng = new Xoshiro128ss(seed);
  const heap = new EventHeap();
  let seq = 0, events = 0;
  const rec = trace ? [] : null;
  for (let n = 0; n < nodes; n++) heap.push({ t: rng.int(0, tickMs), seq: seq++, kind: 'tick', node: n });
  while (heap.size > 0) {
    const ev = heap.pop();
    if (ev.t > horizon) break;
    events++;
    if (rec) rec.push(`${ev.t}|${ev.seq}|${ev.kind}|${ev.node}|${ev.from ?? ''}`);
    if (ev.kind === 'tick') {
      const peer = rng.int(0, 4 /* nodes-1 */);
      heap.push({ t: ev.t + rng.int(1, 30), seq: seq++, kind: 'ping', node: peer, from: ev.node });
      heap.push({ t: ev.t + tickMs, seq: seq++, kind: 'tick', node: ev.node });
    } else if (ev.kind === 'ping') {
      heap.push({ t: ev.t + rng.int(1, 30), seq: seq++, kind: 'pong', node: ev.from, from: ev.node });
    } // pong: terminal
  }
  return { events, hash: rec ? fnv1a(rec.join('\n')) : null };
}

// ---------- (b) determinism: 10 runs, byte-identical trace ----------

const SEED = 0xC0FFEE;
const hashes = [];
for (let i = 0; i < 10; i++) hashes.push(runEcho(SEED).hash);
const allEqual = hashes.every(h => h === hashes[0]);
console.log(`determinism: 10 runs of seed 0x${SEED.toString(16)} -> hashes ${allEqual ? 'ALL EQUAL' : 'DIVERGED'} (0x${hashes[0].toString(16)})`);
const otherSeed = runEcho(SEED + 1).hash;
console.log(`sanity: seed+1 produces a different trace: ${otherSeed !== hashes[0]}`);
if (!allEqual || otherSeed === hashes[0]) process.exit(1);

// ---------- (a) throughput: events/sec, no tracing (hot path) and with tracing ----------

for (const trace of [false, true]) {
  runEcho(1, { horizon: 10_000, trace }); // warmup
  const t0 = process.hrtime.bigint();
  let total = 0;
  for (let s = 0; s < 20; s++) total += runEcho(s, { horizon: 120_000, trace }).events;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`throughput (trace=${trace}): ${total.toLocaleString()} events in ${ms.toFixed(0)} ms -> ${Math.round(total / (ms / 1000)).toLocaleString()} events/sec`);
}

// ---------- (c) structuredClone of a frame-sized view model ----------

const frame = {
  g: 42_000,
  nodes: Array.from({ length: 5 }, (_, i) => ({
    id: i, role: 'follower', term: 7, commitIndex: 812, lastApplied: 812, votedFor: 2,
    alive: true, clockOffset: 0,
    logWindow: Array.from({ length: 30 }, (_, j) => ({ index: 783 + j, term: 7 })),
    logLength: 812,
  })),
  messages: Array.from({ length: 24 }, (_, i) => ({ from: i % 5, to: (i + 1) % 5, kind: 'AppendEntries', sendG: 41_900, deliverG: 42_030 })),
  partitions: [[0, 1, 2], [3, 4]],
};
structuredClone(frame); // warmup
const c0 = process.hrtime.bigint();
const CLONES = 3000;
for (let i = 0; i < CLONES; i++) structuredClone(frame);
const cms = Number(process.hrtime.bigint() - c0) / 1e6;
console.log(`structuredClone: ${(cms / CLONES * 1000).toFixed(1)} us/frame (${JSON.stringify(frame).length} bytes JSON) -> at 30 Hz: ${(cms / CLONES * 30).toFixed(2)} ms/sec budget`);

// ---------- scrub feasibility: single full re-run wall time ----------

const s0 = process.hrtime.bigint();
const one = runEcho(SEED, { horizon: 60_000, trace: false });
const sms = Number(process.hrtime.bigint() - s0) / 1e6;
console.log(`scrub estimate: one 60s-virtual run = ${one.events.toLocaleString()} events in ${sms.toFixed(1)} ms`);
