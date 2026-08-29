import { expect, test } from 'vitest';
import { SIM_VERSION } from '@raftlab/sim';

test('sim package resolves through the workspace alias', () => {
  expect(SIM_VERSION).toBe('0.1.0');
});
