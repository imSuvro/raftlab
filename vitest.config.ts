import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@raftlab/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@raftlab/sim': fileURLToPath(new URL('./packages/sim/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
