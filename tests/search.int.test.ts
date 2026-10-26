import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createInvoice, SearchRateLimiter, searchDocuments } from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  clientWithLoads,
  deliveryScene,
  type DeliveryScene,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// integration I3.3: search by document number, filtered by row-level security, audited misses, lock-out. AC-INT-18.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `se${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let scene: DeliveryScene;
let master: OrderMaster;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const search = (actor: SessionUser, q: string) =>
  searchDocuments(app, actor, q, { limiter: new SearchRateLimiter(1000, 60_000) });
const missesOf = async (actor: SessionUser) =>
  Number(
    (
      await inCtx(users.owner, (tx) =>
        tx.query<{ n: string }>(
          `select count(*)::text as n from audit_event where table_name = 'document_search' and action = 'permission_denied' and actor_user_id = $1`,
          [actor.id],
        ),
      )
    ).rows[0]?.n,
  );

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
});

async function sold() {
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[3000]]);
  const order = c.orders[0]!;
  const made = await createInvoice(
    app,
    users.owner,
    { deliveryIds: order.deliveryIds },
    { today: '2026-07-03' },
  );
  if (!made.ok) throw new Error(made.error);
  return {
    order,
    blNo: order.blNos[0] as string,
    invoiceNumber: made.value.number,
    deliveryId: order.deliveryIds[0] as string,
  };
}
const hits = (r: Awaited<ReturnType<typeof search>>) =>
  r.ok ? r.value.map((d) => `${d.kind}:${d.code}`) : r;

describe('what a search finds (AC-INT-18)', () => {
  it('finds by exact number or by prefix, whatever the case or the spaces', async () => {
    const s = await sold();
    expect(hits(await search(users.owner, s.invoiceNumber))).toContain(`invoice:${s.invoiceNumber}`);
    expect(hits(await search(users.owner, s.invoiceNumber.slice(0, 12).toLowerCase()))).toContain(
      `invoice:${s.invoiceNumber}`,
    );
    expect(hits(await search(users.owner, ` ${s.blNo.toLowerCase()} `))).toContain(`bl:${s.blNo}`);
    expect(hits(await search(users.owner, s.order.code))).toContain(`order:${s.order.code}`);
  });

  it('gives the owner the pages that open each result', async () => {
    const s = await sold();
    const r = await search(users.owner, s.invoiceNumber);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.find((d) => d.kind === 'invoice')?.path).toMatch(/^\/invoices\/[0-9a-f-]{36}$/);
    const bl = await search(users.owner, s.blNo);
    if (!bl.ok) throw new Error(bl.error);
    expect(bl.value.find((d) => d.kind === 'bl')?.path).toBe(`/deliveries/${s.deliveryId}`);
  });

  it('is filtered by row-level security: the plant finds the BL and the order (no link), not the invoice; office finds the BL only', async () => {
    const s = await sold();
    expect(hits(await search(users.plant, s.invoiceNumber))).toEqual([]);
    expect(hits(await search(users.office, s.invoiceNumber))).toEqual([]);
    const plantOrder = await search(users.plant, s.order.code);
    if (!plantOrder.ok) throw new Error(plantOrder.error);
    expect(plantOrder.value).toEqual([{ kind: 'order', code: s.order.code, path: null }]);
    expect(hits(await search(users.office, s.order.code))).toEqual([]);
    const officeBl = await search(users.office, s.blNo);
    if (!officeBl.ok) throw new Error(officeBl.error);
    expect(officeBl.value).toEqual([{ kind: 'bl', code: s.blNo, path: `/deliveries/${s.deliveryId}` }]);
    expect(hits(await search(users.support, s.invoiceNumber))).toContain(`invoice:${s.invoiceNumber}`);
  });

  it('refuses a query that is not a document number before it reaches the database: too short, a name, a pattern', async () => {
    const before = await missesOf(users.owner);
    for (const [q, error] of [
      ['FA', 'TOO_SHORT'],
      ['', 'TOO_SHORT'],
      ['Atlas Béton', 'INVALID'],
      ['%%%%', 'INVALID'],
      ["FA-2026'--", 'INVALID'],
    ] as const)
      expect(await search(users.owner, q)).toEqual({ ok: false, error });
    expect(await missesOf(users.owner)).toBe(before);
  });

  it('finds no client by name, for office or anyone: only numbers are searched', async () => {
    const s = await sold();
    const name = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ name: string }>(
          'select c.name from client c join sales_order o on o.client_id = c.id where o.id = $1',
          [s.order.id],
        ),
      )
    ).rows[0]?.name as string;
    for (const role of ['owner', 'office'] as const) {
      const r = await search(users[role], name);
      expect(r.ok ? r.value : []).toEqual([]);
    }
    expect(await search(users.office, 'Atlas Béton')).toEqual({ ok: false, error: 'INVALID' });
  });
});

describe('probing the numbers (AC-INT-18)', () => {
  it('a search that finds nothing is audited; one that finds something is not', async () => {
    const s = await sold();
    const before = await missesOf(users.partner);
    expect(hits(await search(users.partner, 'FA-2099-99999'))).toEqual([]);
    expect(await missesOf(users.partner)).toBe(before + 1);
    expect(hits(await search(users.partner, s.blNo))).toContain(`bl:${s.blNo}`);
    expect(await missesOf(users.partner)).toBe(before + 1);
  });

  it('ten unknown numbers in ten minutes lock the actor out, as for the office doors', async () => {
    for (let i = 0; i < 10; i += 1) expect(hits(await search(users.support, `ZZ-${1000 + i}`))).toEqual([]);
    expect(await search(users.support, 'ZZ-2000')).toEqual({ ok: false, error: 'TOO_MANY_ATTEMPTS' });
    // the lock-out is the actor's own: another role still searches
    expect((await search(users.owner, 'ZZ-3000')).ok).toBe(true);
  });

  it('is rate-limited per actor', async () => {
    const limiter = new SearchRateLimiter(2, 60_000);
    const go = (actor: SessionUser) => searchDocuments(app, actor, 'BL-2026', { limiter, now: 1_000 });
    expect((await go(users.plant)).ok).toBe(true);
    expect((await go(users.plant)).ok).toBe(true);
    expect(await go(users.plant)).toEqual({ ok: false, error: 'RATE_LIMITED' });
    expect((await go(users.partner)).ok).toBe(true);
  });
});
