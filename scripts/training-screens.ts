// Phone-size screenshots of the training instance, one set per role, for docs/training/screens/ (T5). Run by hand, never in CI:
//   corepack pnpm training:screens        (needs the e2e build: SIMULATION_ENABLED=false NEXT_DIST_DIR=.next-e2e corepack pnpm build)
// It builds a SCRATCH training database (belgobeton_training_test) with the training seed, starts the built app on 127.0.0.1:3190 in
// training mode, signs in as each account with the credentials the seed just issued (read in memory from a private temporary file that is
// deleted afterwards, never written to an image or printed), and saves PNGs at 390x844, device scale factor 2. Only pages AFTER sign-in are
// photographed, so no password or PIN is ever on screen. Fictitious data only.
// R14-14: every page is asserted to have LOADED (a status below 400, the address asked for, not a 404 or a redirect to the sign-in) before it is
// photographed, and the script fails otherwise; every image carries a visible "fictif" label; the seed's realistic first names for drivers are
// replaced, in the picture only, by unambiguous invented labels ("Chauffeur fictif A") so that no image reads as a named worker's record.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import pg from 'pg';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase } from './db-bootstrap';
import { runMigrations } from './db-migrate';
import { seedTraining } from './seed-training';
import { handleHelp } from './cli-help';
import { testEnv } from '../tests/db-env';
import { businessDateOf, realClock } from '../src/modules/clock/index.ts';

handleHelp(import.meta.url);

const PORT = 3190;
const BASE = `http://localhost:${PORT}`;
const OUT = 'docs/training/screens';

interface Cred {
  label: string;
  login: string;
  secret: string;
}
function parseCredentials(text: string): Cred[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split('\n'))
    .flatMap((lines) => {
      const label = lines[0]?.trim();
      const login = lines
        .find((l) => /^\s+(e-mail|code)\s*:/.test(l))
        ?.replace(/^[^:]+:\s*/, '')
        .trim();
      const secret = lines
        .find((l) => /^\s+(mot de passe|PIN)\s*:/.test(l))
        ?.replace(/^[^:]+:\s*/, '')
        .trim();
      return label && login && secret ? [{ label, login, secret }] : [];
    });
}

const SHOTS: { key: string; label: RegExp; pages: [string, string][] }[] = [
  {
    key: 'ventes',
    label: /^Bureau ventes/,
    // The sales office reads orders without money (the chain) and writes quotes; the money lists are the owner's.
    pages: [
      ['orders-chain', '/fr/orders/chain'],
      ['quotes-new', '/fr/quotes/new'],
    ],
  },
  {
    key: 'achats',
    label: /^Bureau achats/,
    // The purchasing office writes purchases and sees the plant's receipts; the money list and the stock board are not its pages.
    pages: [
      ['purchases-new', '/fr/purchases/new'],
      ['receipts', '/fr/receipts'],
    ],
  },
  {
    key: 'centrale-tetouan',
    label: /^Chef de centrale Tétouan/,
    pages: [
      ['dispatch', '/fr/dispatch'],
      ['stock', '/fr/stock'],
    ],
  },
  {
    key: 'centrale-chefchaouen',
    label: /^Chef de centrale Chefchaouen/,
    pages: [
      ['dispatch', '/fr/dispatch'],
      ['transfers', '/fr/transfers'],
    ],
  },
  {
    key: 'comptable',
    label: /^Comptable/,
    pages: [
      ['invoices', '/fr/invoices'],
      ['accounting', '/fr/accounting'],
    ],
  },
  {
    key: 'proprietaire',
    label: /^Propriétaire/,
    pages: [
      ['home', '/fr'],
      ['approvals', '/fr/approvals'],
    ],
  },
  { key: 'admin', label: /^Administrateur/, pages: [['users', '/fr/admin/users']] },
];

/** The label every image carries, in French and in Arabic. */
const FICTION_LABEL = 'FICTIF · données inventées pour la formation / بيانات وهمية للتدريب';

/**
 * Makes the page ready to be photographed: replaces the seed's driver first names by invented labels (in the picture only; the database
 * keeps its data) and adds the visible fiction label. `into` = a selector: the label is put at the top of that element (a crop); without
 * it, as a fixed bar at the top of the page.
 */
async function prepareShot(page: Page, driverNames: string[], into?: string): Promise<void> {
  await page.evaluate(
    ({ names, label, into: target }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      names.forEach((name, i) => {
        const fake = `Chauffeur fictif ${String.fromCharCode(65 + (i % 26))}`;
        for (const node of nodes) if (node.data.includes(name)) node.data = node.data.split(name).join(fake);
      });
      const bar = document.createElement('div');
      bar.setAttribute('data-testid', 'fiction-label');
      bar.textContent = label;
      bar.style.cssText =
        'background:#b00020;color:#fff;font:700 11px/22px sans-serif;text-align:center;direction:ltr;' +
        (target ? '' : 'position:fixed;top:0;left:0;right:0;z-index:2147483647;');
      const host = target ? document.querySelector(target) : null;
      if (host) host.prepend(bar);
      else document.body.append(bar);
    },
    { names: driverNames, label: FICTION_LABEL, into },
  );
}

/** Goes to a page and fails unless it really loaded: a status below 400, and the address asked for (not a 404, not a redirect to sign-in). */
async function openPage(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  if (!response || response.status() >= 400)
    throw new Error(`screenshot page ${url} answered ${response?.status() ?? 'nothing'}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const landed = new URL(page.url());
  if (landed.pathname !== new URL(url).pathname)
    throw new Error(`screenshot page ${url} landed on ${landed.pathname}`);
  // Next.js serves its not-found page with the layout around it: look for it as well.
  if (await page.locator('text=/^404$|This page could not be found/').count())
    throw new Error(`screenshot page ${url} is a 404 page`);
}

async function main() {
  process.env.E2E_TEST_RUNNER ??= 'training-screens'; // R14-13: the positive runner signal the throwaway-database seed escape needs
  const env = testEnv(TRAINING_TEST_DATABASE);
  const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-screens-'));
  chmodSync(dir, 0o700);
  const credentialsFile = path.join(dir, 'training-accounts.local.txt');
  let server: ReturnType<typeof spawn> | null = null;
  try {
    await ensureRoles(training, env.DATABASE_URL_SEED);
    await recreateDatabase(training, TRAINING_TEST_DATABASE);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
    await seedTraining({
      provenance: 'unverified-test-database',
      env: { ...training, APP_BASE_URL: BASE },
      today: businessDateOf(realClock.now()),
      credentialsFile,
    });
    const creds = parseCredentials(readFileSync(credentialsFile, 'utf8'));
    // The drivers' names as the seed made them, longest first so that no name hides inside another.
    const namesPool = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
    const driverNames = (
      await namesPool.query<{ name: string }>(`select name from driver order by code`)
    ).rows
      .map((r) => r.name)
      .sort((a, b) => b.length - a.length);
    await namesPool.end();

    server = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(PORT)],
      {
        env: {
          ...process.env,
          NEXT_DIST_DIR: '.next-e2e',
          NODE_ENV: 'test',
          DATABASE_URL_APP: env.DATABASE_URL_APP,
          DATABASE_URL_AUTH: env.DATABASE_URL_AUTH,
          DATABASE_URL_SYSTEM: env.DATABASE_URL_SYSTEM,
          DATABASE_URL_MIGRATOR: env.DATABASE_URL_MIGRATOR,
          APP_BASE_URL: BASE,
          TRAINING_MODE: 'true',
          APP_ENV: 'training',
          SIMULATION_ENABLED: 'false',
          REAL_DATA: 'false',
          JOB_SCHEDULER_DISABLED: 'true',
          FILE_STORE_DIR: path.join(dir, 'files'),
          FIELD_APP_ENABLED: 'true',
          NOTIFICATIONS_ENABLED: 'true',
          CANCELLATIONS_ENABLED: 'true',
          DOCUMENTS_V1_ENABLED: 'true',
          DARIJA_ENABLED: 'true',
          ASSISTANT_DET_ENABLED: 'true',
          TRANSFERS_ENABLED: 'true',
          FINANCE_ENABLED: 'true',
        },
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 60; i++) {
      if ((await fetch(`${BASE}/api/health/ready`).catch(() => null))?.ok) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    const phone = {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'fr-FR',
    };
    try {
      for (const shot of SHOTS) {
        const cred = creds.find((c) => shot.label.test(c.label));
        if (!cred) throw new Error(`no account for ${shot.key}`);
        const ctx = await browser.newContext(phone);
        const page = await ctx.newPage();
        await page.goto(`${BASE}/fr/login`);
        await page.fill('input[name=email]', cred.login);
        await page.fill('input[name=password]', cred.secret);
        await page.click('button[type=submit]');
        await page.waitForURL(`${BASE}/fr`, { timeout: 30_000 });
        for (const [name, url] of shot.pages) {
          await openPage(page, `${BASE}${url}`);
          await prepareShot(page, driverNames);
          await page.screenshot({ path: `${OUT}/${shot.key}-${name}.png` });
          if (name === 'dispatch' && (await page.getByTestId('timing-board').count())) {
            // the crop has its own label, inside the element (the page's fixed bar is not part of an element screenshot)
            await page.getByTestId('fiction-label').evaluate((el) => el.remove());
            await prepareShot(page, [], '[data-testid=timing-board]');
            await page.getByTestId('timing-board').screenshot({ path: `${OUT}/${shot.key}-timing.png` });
          }
        }
        await ctx.close();
      }
      // the phones: a driver (the first), and the pump operator
      for (const [key, test] of [
        ['chauffeur', (c: Cred) => /^Chauffeur/.test(c.label)],
        ['pompiste', (c: Cred) => /^Pompiste/.test(c.label)],
      ] as const) {
        // the last driver is the one whose rotation is already on the road, so the late banner is on his screen
        const cred = creds.filter(test).at(-1);
        if (!cred) throw new Error(`no account for ${key}`);
        const ctx = await browser.newContext(phone);
        const page = await ctx.newPage();
        await page.goto(`${BASE}/fr/driver`);
        await page.getByTestId('field-code').fill(cred.login);
        await page.getByTestId('field-pin').fill(cred.secret);
        await page.getByTestId('field-signin').click();
        await page.getByTestId('field-day').waitFor({ timeout: 30_000 });
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await prepareShot(page, driverNames);
        await page.screenshot({ path: `${OUT}/${key}-day.png` });
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
    console.log(`screenshots written to ${OUT}`);
  } finally {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
