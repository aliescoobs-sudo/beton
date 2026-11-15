import { expect, request as playwrightRequest, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createFieldAccount, setDriverPin } from '../src/modules/field';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import {
  deliveryScene,
  insertDelivery,
  insertInvoice,
  insertQuote,
  orderMaster,
} from '../tests/helpers/ledger-fixtures';
import { E2E_BASE_URL } from './fixtures';
import {
  actionRefused,
  businessWrites,
  denied,
  identityFactory,
  reached,
  routeInventory,
  send,
  serverActions,
  WRITE_METHODS,
  type Method,
} from './sweep-support';

// R19 group 3B: the authenticated negative matrices that had no counterpart. (1) a phone (driver) token and (2) a pump_operator token against every office and
// history page and API; (3) an accountant against every write route and server action; (4) the office roles against the PDF and export routes with REAL, KNOWN targets.
// Each matrix has its positive control: the same token or role reaches what it is entitled to.
const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
const PASSWORD = 'correct-horse-battery-staple';
const identity = identityFactory({
  env: env as never,
  migrator,
  authPool,
  createAuth: createAuth as never,
  createUser: createUser as never,
  bootstrapActor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
  password: PASSWORD,
});
const marker = `rn${randomUUID().replace(/-/g, '').slice(0, 8)}`;
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await migrator.query(`update "user" set status = 'disabled' where email like 'e2e-neg-%'`);
  await Promise.all([migrator.end(), app.end(), authPool.end()]);
});

/** A phone token: a field account for a driver of this kind, a PIN, a real login over HTTP; the cookie header it gets. */
async function phoneCookie(kind: 'driver' | 'pump_operator'): Promise<string> {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const auth = createAuth({ authPool, env: { ...env, APP_BASE_URL: E2E_BASE_URL } });
  const deps = { appPool: app, authPool, auth, secret: env.AUTH_SECRET };
  let row: { id: string; code: string } | undefined;
  for (let i = 0; i < 40 && !row; i++) {
    const no = 100 + Math.floor(Math.random() * 8800);
    try {
      row = (
        await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
          tx.query<{ id: string; code: string }>(
            `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, $4) returning id, code`,
            [`CH-${no}`, `${marker} ${kind} ${no}`, owner.id, kind],
          ),
        )
      ).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  if (!row) throw new Error('no free driver code');
  expect((await createFieldAccount(deps, owner, row.id)).ok).toBe(true);
  expect((await setDriverPin(deps, owner, { driverId: row.id, pin: '482913' })).ok).toBe(true);
  const ctx = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
  const res = await ctx.post('/api/field/login', {
    data: { code: row.code, pin: '482913', deviceId: `phone-${randomUUID()}-0123456789abcdef` },
    headers: { origin: E2E_BASE_URL },
  });
  expect(res.status(), `the ${kind} signs in on the phone`).toBe(200);
  const cookie = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value.split(';')[0]!)
    .join('; ');
  await ctx.dispose();
  expect(cookie).toContain('bb_field');
  return cookie;
}

for (const kind of ['driver', 'pump_operator'] as const) {
  test(`${kind}: a phone token is not a browser session — every office and history page, every API outside /api/field, every PDF and export route and every server action refuses it (the same token still works on its own door)`, async () => {
    test.setTimeout(900_000);
    const cookie = await phoneCookie(kind);
    // positive control: the token is valid where it is meant to be
    expect((await send(cookie, 'GET', '/api/field/session')).status).toBe(200);
    const { pages, routes } = routeInventory();
    const leaks: string[] = [];
    for (const p of pages) {
      const r = await send(cookie, 'GET', p);
      if (!denied(r)) leaks.push(`GET ${p} -> ${r.status}`);
    }
    for (const route of routes.filter((r) => !r.url.startsWith('/api/field/')))
      for (const m of route.methods) {
        const r = await send(cookie, m, route.url);
        if (!denied(r)) leaks.push(`${m} ${route.url} -> ${r.status}`);
      }
    const writes0 = await businessWrites(migrator);
    for (const a of serverActions()) {
      const r = await send(cookie, 'POST', a.url, {
        'next-action': a.id,
        'content-type': 'text/plain;charset=UTF-8',
      });
      if (!actionRefused(r))
        leaks.push(
          `ACTION ${a.id.slice(0, 10)} ${a.url} -> ${r.status} ${JSON.stringify(r.body.slice(0, 160))}`,
        );
    }
    expect(leaks).toEqual([]);
    expect(await businessWrites(migrator), 'the phone token wrote nothing through the office actions').toBe(
      writes0,
    );
  });
}

test('pump_operator: the phone doors that belong to a driver are refused to a pump operator (BL photo), and a driver tap cannot be synced as a pump operator', async () => {
  const cookie = await phoneCookie('pump_operator');
  const photo = await send(cookie, 'POST', '/api/field/bl-photo');
  expect([401, 403, 400, 404], 'refused, not served').toContain(photo.status);
  expect(photo.status).not.toBe(200);
  const ctx = await playwrightRequest.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { cookie, origin: E2E_BASE_URL },
  });
  const sync = await ctx.post('/api/field/sync', {
    data: {
      actions: [
        {
          kind: 'step',
          key: `k-${randomUUID()}`,
          tripId: randomUUID(),
          step: 'loaded',
          at: new Date().toISOString(),
        },
      ],
    },
  });
  const body = await sync.text();
  expect(body).not.toMatch(/"status":"recorded"/);
  await ctx.dispose();
});

test("accountant: no write route and no server action accepts the role (reads stay); every denial is judged with the accountant's own live session", async () => {
  test.setTimeout(900_000);
  const acc = await identity('accountant', 'accountant');
  const { routes } = routeInventory();
  // what an accountant may do with a write verb, by design (a notification subscription, the assistant): everything else must be denied
  const MAY: Record<string, string> = {
    'POST /api/push': 'its own notification subscription',
    'DELETE /api/push': 'its own notification subscription',
    'POST /api/assistant/ask': 'the assistant is open to every signed-in role (its tools are role-scoped)',
    'POST /api/assistant/proposals/00000000-0000-7000-8000-000000000000/confirm': '',
  };
  const writes: string[] = [];
  for (const route of routes)
    for (const m of route.methods.filter((x) => (WRITE_METHODS as readonly string[]).includes(x))) {
      const r = await send(acc.cookie, m as Method, route.url);
      const key = `${m} ${route.url}`;
      if (!denied(r) && !MAY[key] && !/^POST \/api\/assistant/.test(key))
        writes.push(`${key} -> ${r.status}`);
    }
  const writes0 = await businessWrites(migrator);
  for (const a of serverActions()) {
    const r = await send(acc.cookie, 'POST', a.url, {
      'next-action': a.id,
      'content-type': 'text/plain;charset=UTF-8',
    });
    // an action answers the accountant by a denial, by doing nothing, or by failing on the arguments it was not given (a 5xx); what must never happen is an action that DID something
    if (r.status === 200 && /"ok":true/.test(r.body))
      writes.push(`ACTION ${a.id.slice(0, 10)} ${a.url} -> executed`);
  }
  expect(writes).toEqual([]);
  const after = await businessWrites(migrator);
  if (after !== writes0) {
    const rows = await migrator.query(
      `select action, table_name, actor_user_id from audit_event where action in ('insert','update','reverse','archive','import','export','user_created','user_disabled','user_enabled') order by id desc limit $1`,
      [after - writes0],
    );
    console.log('NEWWRITES', JSON.stringify(rows.rows));
  }
  expect(after, 'no server action wrote anything for the accountant').toBe(writes0);
  // the accountant's capture of a business write in the audit log: none (its session wrote nothing through the sweep)
  const wrote = await migrator.query(
    `select 1 from audit_event where actor_user_id = $1 and action in ('insert','update','reverse','archive') and table_name not in ('notification','push_subscription')`,
    [acc.id],
  );
  expect(wrote.rowCount).toBe(0);
  // control: the accountant reads what it may
  expect(reached(await send(acc.cookie, 'GET', '/fr'))).toBe(true);
});

test('office roles: the known PDF and export targets (a real invoice, quote, statement) are refused to the blind office roles and served to the admin control', async () => {
  test.setTimeout(600_000);
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  // real targets (made here, with the ledger fixtures, if the shared e2e database has none yet)
  const master = await orderMaster(app, owner.id, marker);
  const scene = await deliveryScene(app, owner.id, marker);
  const made = await withRlsContext(
    app,
    { userId: owner.id, role: 'owner', requestId: marker },
    async (tx) => {
      const dl = await insertDelivery(tx, owner.id, scene, 1000);
      const delivery = (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [dl.blNo]))
        .rows[0]!;
      const inv = await insertInvoice(
        tx,
        owner.id,
        scene,
        { id: delivery.id, blNo: dl.blNo },
        `Client ${marker}`,
        1000,
      );
      const quote = await insertQuote(tx, owner.id, master);
      return { invoice: inv.id, quote: quote.id, delivery: delivery.id };
    },
  );
  const targets: [string, string][] = [
    ['invoice PDF', `/fr/invoices/${made.invoice}/pdf`],
    ['quote PDF', `/fr/quotes/${made.quote}/pdf`],
    ['client statement PDF', `/fr/statements/client/${scene.clientId}/pdf`],
    ['client statement export', `/fr/statements/client/${scene.clientId}/export`],
    // T19c B2/B3: the aging screens, their CSV and the cash forecast follow the side split of the statements (each office role reads its own side, the blind office none)
    ['client aging export', '/fr/aging/export?kind=client'],
    ['supplier aging export', '/fr/aging/export?kind=supplier'],
    ['aging screen', '/fr/aging'],
    ['cash forecast screen', '/fr/forecast'],
    ['accounting export', '/fr/accounting/export?file=sales&from=2026-01-01&to=2026-12-31'],
    ['finance export', '/fr/finance/export?from=2026-01-01&to=2026-12-31'],
  ];
  const ownerId = await identity('admin-control', 'app_admin');
  for (const [label, url] of targets.filter(([l]) => l !== 'finance export'))
    // the finance module's database switch is a state other specs set; its denial for the office roles is asserted below all the same
    expect(
      reached(await send(ownerId.cookie, 'GET', url)),
      `${label}: the app_admin control reaches it`,
    ).toBe(true);
  // not money-blind: the delivery note PDF is for every office role (the control that the office session is a good one)
  const leaks: string[] = [];
  for (const role of ['office', 'office_sales', 'office_purchases'] as const) {
    const who = await identity(`office-${role}`, role);
    expect(
      reached(await send(who.cookie, 'GET', `/fr/deliveries/${made.delivery}/pdf`)),
      `${role}: its own document`,
    ).toBe(true);
    for (const [label, url] of targets) {
      const r = await send(who.cookie, 'GET', url);
      // D245: the Responsable (office_sales) reads the CLIENT side, statements included; everything else stays refused to every office role
      const ownSide =
        (role === 'office_sales' &&
          (label.startsWith('client statement') || label === 'client aging export')) ||
        (role === 'office_purchases' && label === 'supplier aging export') ||
        (role !== 'office' && (label === 'aging screen' || label === 'cash forecast screen'));
      if (ownSide) expect(reached(r), `${role}: its own side, ${label}`).toBe(true);
      else if (!denied(r)) leaks.push(`${role}: ${label} (${url}) -> ${r.status}`);
    }
  }
  expect(leaks).toEqual([]);
});
