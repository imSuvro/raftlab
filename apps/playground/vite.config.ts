import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Alias the workspace packages to their TypeScript sources so the dev server
// hot-reloads library edits and the production bundle inlines them (no
// prebuilt dist required for the app build).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@raftlab/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@raftlab/sim': fileURLToPath(new URL('../../packages/sim/src/index.ts', import.meta.url)),
    },
  },
  build: { target: 'es2022' },
});
