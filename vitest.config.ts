import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
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
