// Seeded PRNG per ADR-0002: xoshiro128** for streams, splitmix32 for
// seeding and stream-splitting. All 32-bit integer math via Math.imul and
// unsigned shifts — no BigInt, no floats in anything that feeds the
// scheduler. Independent streams per concern keep the minimizer stable:
// deleting a workload op never perturbs network draws.

export type U32 = number;

export function splitmix32(seed: U32): () => U32 {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function rotl(x: U32, k: number): U32 {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Xoshiro128 {
  private s0: U32;
  private s1: U32;
  private s2: U32;
  private s3: U32;

  constructor(seed: U32) {
    const sm = splitmix32(seed);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    // A theoretical all-zero state never advances; splitmix32 cannot emit
    // four zeros from any seed, but guard anyway.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s3 = 1;
  }

  nextU32(): U32 {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform integer in [lo, hi] inclusive, via rejection sampling (unbiased). */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new Error(`rng.int: empty range [${lo}, ${hi}]`);
    const range = hi - lo + 1;
    if (range > 0x100000000) throw new Error('rng.int: range exceeds u32');
    const limit = 0x100000000 - (0x100000000 % range);
    let draw = this.nextU32();
    while (draw >= limit) draw = this.nextU32();
    return lo + (draw % range);
  }

  /** Bernoulli draw with probability p expressed in parts-per-million. */
  chancePpm(ppm: number): boolean {
    if (ppm <= 0) return false;
    if (ppm >= 1_000_000) return true;
    return this.int(0, 999_999) < ppm;
  }
}

export interface RngStreams {
  net: Xoshiro128;
  timer: Xoshiro128;
  fault: Xoshiro128;
  workload: Xoshiro128;
}

/** Split four independent streams from one master seed. */
export function splitStreams(seed: U32): RngStreams {
  const sm = splitmix32(seed);
  return {
    net: new Xoshiro128(sm()),
    timer: new Xoshiro128(sm()),
    fault: new Xoshiro128(sm()),
    workload: new Xoshiro128(sm()),
  };
}
