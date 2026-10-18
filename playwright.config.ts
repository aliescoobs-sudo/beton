import { defineConfig, devices } from '@playwright/test';
import { E2E_DATABASE } from './scripts/db-bootstrap';
import { testEnv } from './tests/db-env';
import { E2E_BASE_URL, E2E_PORT } from './e2e/fixtures';

const env = testEnv(E2E_DATABASE);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: E2E_BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Production build (pnpm build runs first in test:e2e), on the e2e database.
    command: `node node_modules/next/dist/bin/next start -p ${E2E_PORT}`,
    // Wait on the port only: pages query the e2e database, which globalSetup may still be creating.
    port: E2E_PORT,
    reuseExistingServer: false,
    env: {
      DATABASE_URL_APP: env.DATABASE_URL_APP,
      DATABASE_URL_AUTH: env.DATABASE_URL_AUTH,
      DATABASE_URL_SYSTEM: env.DATABASE_URL_SYSTEM,
      DATABASE_URL_MIGRATOR: env.DATABASE_URL_MIGRATOR,
      APP_BASE_URL: E2E_BASE_URL,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
