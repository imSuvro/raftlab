// Share URLs per ADR-0005:
//   #v1.<seed>.<base64url(deflate-raw(JSON(scenario minus v and seed)))>
// v and seed ride in the plaintext prefix; the decoder reassembles them, so
// a link reproduces the run exactly — injected faults included.

import { defaultScenario, validateScenario, type Scenario } from '@raftlab/sim';

const PREFIX = 'v1';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '==='.slice((padded.length + 3) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function squeeze(bytes: Uint8Array, mode: 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream(mode));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function expand(bytes: Uint8Array, mode: 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(mode));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeScenario(scenario: Scenario): Promise<string> {
  // v and seed ride in the plaintext prefix, so they are stripped here and
  // reassembled by decodeScenario.
  const rest: Partial<Scenario> = { ...scenario };
  delete rest.v;
  delete rest.seed;
  const json = new TextEncoder().encode(JSON.stringify(rest));
  const packed = await squeeze(json, 'deflate-raw');
  return `#${PREFIX}.${scenario.seed}.${toBase64Url(packed)}`;
}

export async function decodeScenario(hash: string): Promise<Scenario | null> {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (text === '') return null;
  const dot1 = text.indexOf('.');
  const dot2 = text.indexOf('.', dot1 + 1);
  if (dot1 < 0 || dot2 < 0) return null;
  if (text.slice(0, dot1) !== PREFIX) return null;
  const seed = Number(text.slice(dot1 + 1, dot2));
  if (!Number.isInteger(seed)) return null;
  try {
    const packed = fromBase64Url(text.slice(dot2 + 1));
    const json = new TextDecoder().decode(await expand(packed, 'deflate-raw'));
    const scenario = { v: 1, seed, ...(JSON.parse(json) as object) } as Scenario;
    validateScenario(scenario);
    return scenario;
  } catch {
    return null;
  }
}

/** The default run: 5 nodes, mild delays, no faults, a steady client
 *  workload — already in motion when the page loads. */
export function startingScenario(seed = 1): Scenario {
  return defaultScenario(seed, {
    horizonMs: 600_000,
    net: { delayMs: [8, 45], dropPpm: 0, dupPpm: 0 },
    workload: { clients: 3, opsPerClient: 400, keys: 5 },
  });
}
