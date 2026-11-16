import { defineConfig, devices } from '@playwright/test';
import { TRAINING_TEST_DATABASE } from './scripts/db-bootstrap';
import { testEnv } from './tests/db-env';

// T20 (D251): the browser check of the fictitious twin. It has its OWN database (the scratch training database, built by e2e-twin/global-setup.ts: migrations, the
// training seed in profile twin-base, the twin seed) and its own server on its own port, so the shared e2e database of the main suite is never touched and the main
// suite never sees the twin. Run it on the same build as the main suite:
//   NEXT_DIST_DIR=.next-e2e corepack pnpm exec playwright test -c playwright.twin.config.ts      (corepack pnpm test:e2e:twin)
const env = testEnv(TRAINING_TEST_DATABASE);
export const TWIN_PORT = 3103;
export const TWIN_URL = `http://localhost:${TWIN_PORT}`;

export default defineConfig({
  testDir: 'e2e-twin',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  globalSetup: './e2e-twin/global-setup.ts',
  outputDir: './.logs/playwright-twin',
  use: { baseURL: TWIN_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${TWIN_PORT}`,
    port: TWIN_PORT,
    reuseExistingServer: false,
    env: {
      DATABASE_URL_APP: env.DATABASE_URL_APP,
      DATABASE_URL_AUTH: env.DATABASE_URL_AUTH,
      DATABASE_URL_SYSTEM: env.DATABASE_URL_SYSTEM,
      DATABASE_URL_MIGRATOR: env.DATABASE_URL_MIGRATOR,
      APP_BASE_URL: TWIN_URL,
      JOB_SCHEDULER_DISABLED: 'true',
      FILE_STORE_DIR: '.logs/twin-file-store',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'test',
      // the training instance: the database carries the training marker, so no override is needed
      TRAINING_MODE: 'true',
      APP_ENV: 'training',
      ASSISTANT_PROVIDER: 'fake',
      FIELD_APP_ENABLED: 'true',
      NOTIFICATIONS_ENABLED: 'true',
      CANCELLATIONS_ENABLED: 'true',
      DOCUMENTS_V1_ENABLED: 'true',
      DARIJA_ENABLED: 'true',
      ASSISTANT_DET_ENABLED: 'true',
      TRANSFERS_ENABLED: 'true',
      FINANCE_ENABLED: 'true',
    },
  },
});
