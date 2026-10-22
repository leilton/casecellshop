import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Mutation testing (stryker.config.json) only needs the tests that exercise checkout and invoicing; running
// the whole suite for every mutant would multiply the run time for no extra kills.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        'src/modules/checkout/**/*.test.ts',
        'src/modules/invoicing/**/*.test.ts',
        'src/worker/consumer.test.ts',
        'tests/integration/checkout.*.test.ts',
        'tests/integration/invoicing.test.ts',
        'tests/integration/orders.cancel.test.ts',
        'tests/integration/outbox-queue.test.ts',
        // The HTTP layer of checkout (validation messages, metric labels, shedding) is only reached through these.
        'tests/integration/api.http.test.ts',
      ],
      coverage: { enabled: false },
    },
  }),
);
