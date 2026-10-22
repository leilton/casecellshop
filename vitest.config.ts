import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    // Integration tests share one Postgres/Redis; separate processes keep metric registries and pools isolated.
    pool: 'forks',
    // Files run one at a time: the outbox relay publishes every pending row of shop_test, so a parallel file's
    // orders could be invoiced by another file's consumer. The whole suite takes a few seconds anyway.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/api/server.ts', 'src/worker/index.ts', 'src/observability/**'],
      // json-summary feeds the CI job summary; lcov is for editors and coverage services.
      reporter: ['text-summary', 'text', 'html', 'json-summary', 'lcov'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});
