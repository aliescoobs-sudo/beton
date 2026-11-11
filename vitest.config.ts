import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // T17: the master-data domain (money, prices, recettes, trucks) stays covered by unit and integration tests together.
    // Run with `pnpm test:coverage`.
    coverage: {
      provider: 'v8',
      include: [
        'src/modules/master-data/domain/**',
        // ledger L26: the money domain (totals, plans, instruments, statements, journals) stays covered at the same bar.
        'src/modules/ledger/domain/**',
        'src/modules/operations/domain/**',
        // rules-engine R10: the brain's pure domain (forecast, rules, options, stock risk) at the same bar.
        'src/modules/rules-engine/domain/**',
      ],
      exclude: ['**/*.test.ts'],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
          exclude: ['**/*.int.test.{ts,tsx}', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts', 'tests/**/*.int.test.ts'],
          globalSetup: ['tests/setup-db.ts'],
          fileParallelism: false,
          // T11b: a shared CI runner is slower than a developer machine; two suites (second-factor hashing, plant views) passed the 5 s default
          // only on an idle machine. A real hang still fails, 20 s later.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
