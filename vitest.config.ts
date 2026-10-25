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
        },
      },
    ],
  },
});
