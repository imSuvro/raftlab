import tseslint from 'typescript-eslint';

// The determinism ban: packages/core and packages/sim must never read the
// wall clock, ambient randomness, or host timers, and must stay sans-IO.
// Three rule families because each catches a distinct syntactic form:
//   no-restricted-globals    — bare identifiers: setTimeout(...), performance
//   no-restricted-properties — member access: Date.now, Math.random, reaches
//                              through globalThis/window
//   no-restricted-syntax     — constructor/call forms: new Date(), Date()
// Math itself stays allowed: the PRNG needs Math.imul/floor.
const DETERMINISM_BAN = {
  'no-restricted-globals': [
    'error',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'setImmediate', 'queueMicrotask', 'requestAnimationFrame',
    'performance', 'crypto', 'process',
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'No wall clock in core/sim. Time arrives in inputs.' },
    { object: 'Math', property: 'random', message: 'No ambient randomness. Use the seeded PRNG streams.' },
    { object: 'globalThis', property: 'setTimeout' },
    { object: 'globalThis', property: 'setInterval' },
    { object: 'globalThis', property: 'performance' },
    { object: 'globalThis', property: 'crypto' },
    { object: 'globalThis', property: 'process' },
    { object: 'window', property: 'setTimeout' },
    { object: 'window', property: 'performance' },
  ],
  'no-restricted-syntax': [
    'error',
    { selector: 'NewExpression[callee.name="Date"]', message: 'No wall-clock time in core/sim. Use virtual time from inputs.' },
    { selector: 'CallExpression[callee.name="Date"]', message: 'Date() reads the wall clock.' },
  ],
  'no-restricted-imports': [
    'error',
    {
      patterns: [{
        group: ['node:*', 'fs', 'path', 'os', 'timers', 'timers/*', 'crypto', 'child_process', 'worker_threads'],
        message: 'core/sim are sans-IO. IO belongs to the CLI and app layers.',
      }],
    },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', 'docs/**'] },
  ...tseslint.configs.strict.map((c) => ({ ...c, files: ['**/*.ts', '**/*.tsx'] })),
  {
    files: ['packages/core/src/**/*.ts', 'packages/sim/src/**/*.ts'],
    rules: DETERMINISM_BAN,
  },
  {
    // The fuzz/repro CLI legitimately writes failure artifacts and reads
    // scenario files; only the IO-import ban is relaxed. The clock and
    // randomness bans stay — even the CLI must not smuggle wall time in.
    files: ['packages/sim/src/cli/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': ['error',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'setImmediate', 'queueMicrotask', 'requestAnimationFrame'],
    },
  },
);
