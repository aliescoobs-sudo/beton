import { defineConfig, devices } from '@playwright/test';

// T10g: browser checks of the STAGING gate (HTTP Basic Auth on the whole vhost), run by scripts/staging/rehearse.sh against the LOCAL rehearsal stack
// (Caddy's internal CA, a *.localhost name, loopback ports). Not part of the ordinary e2e run: it needs that stack. No secret is in this file; the canary
// Basic credentials come from the environment of the rehearsal.
const host = process.env.REHEARSAL_HOST ?? 'kayas-staging.localhost';
const port = process.env.REHEARSAL_HTTPS ?? '18443';
export default defineConfig({
  testDir: './e2e-staging',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './.logs/playwright-staging',
  use: {
    baseURL: `https://${host}:${port}`,
    ...devices['Desktop Chrome'],
    // Caddy's internal CA is trusted for this run by its public-key hash (REHEARSAL_SPKI, computed by rehearse.sh from the CA in the proxy volume). A blanket
    // ignoreHTTPSErrors would stop service workers from registering, and a service worker is exactly what has to be proved here.
    launchOptions: {
      args: process.env.REHEARSAL_SPKI
        ? [`--ignore-certificate-errors-spki-list=${process.env.REHEARSAL_SPKI}`]
        : [],
    },
  },
});
