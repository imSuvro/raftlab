import { expect, test } from 'vitest';
import { CORE_VERSION } from '@raftlab/core';

test('core package resolves through the workspace alias', () => {
  expect(CORE_VERSION).toBe('0.1.0');
});
