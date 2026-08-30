// Replays every committed minimized-failure scenario (ADR-0005): once a bug
// is fixed, its scenario lives here forever and must run violation-free.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { captureFailure, parseScenario } from '@raftlab/sim';

const dir = join(__dirname, 'regressions');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

describe('regression corpus', () => {
  test(`corpus directory enumerable (${files.length} scenario(s))`, () => {
    expect(Array.isArray(files)).toBe(true);
  });

  for (const file of files) {
    test(`${file} stays fixed`, () => {
      const scenario = parseScenario(readFileSync(join(dir, file), 'utf8'));
      const { violation } = captureFailure(scenario, { paranoidEveryEvents: 1000 });
      expect(violation).toBeNull();
    });
  }
});
