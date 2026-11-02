import { generateKeyPairSync } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createPlant, updatePlant } from '../src/modules/master-data';
import {
  dropSubscription,
  flushPush,
  listMyNotifications,
  markRead,
  NOTIFICATION_KINDS,
  saveSubscription,
  sendTestNotification,
  unreadCount,
  vapidJwt,
} from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

// R5 (CP-PROD-PLAN, REQUIREMENTS-V1 §13): the catalogue, who receives what, own rows only, no amount, push without content.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await Promise.all([app.end(), migrator.end(), system.end()]);
});
const marker = `nt${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const u = {} as Record<string, SessionUser>;
let ownerId = '';
let plantId = '';
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

const notify = (kind: string, roles: string[], params: object = {}, plant: string | null = null) =>
  withRlsContext(migrator, { userId: ownerId, role: 'owner', requestId: marker }, (tx) =>
    tx.query(`select public.notify($1, 'info', $2::jsonb, null, $3, $4::text[], null)`, [
      kind,
      JSON.stringify(params),
      plant,
      roles,
    ]),
  );
const kindsOf = async (who: string, kind?: string) =>
  (await listMyNotifications(app, u[who]!, 200)).filter((n) => !kind || n.kind === kind);

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  ownerId = v.owner.id;
  plantId = v.plantId;
  for (const r of [
    'app_admin',
    'office_sales',
    'office_purchases',
    'plant_manager',
    'driver',
    'accountant',
  ] as const)
    u[r] = v.session(r);
  u.owner = v.owner;
});

describe('the catalogue (§13)', () => {
  it('the database accepts exactly the kinds of the catalogue', async () => {
    for (const k of NOTIFICATION_KINDS) await expect(notify(k, ['accountant']), k).resolves.toBeDefined();
    await expect(notify('not_a_kind', ['accountant'])).rejects.toThrow();
    expect((await kindsOf('accountant')).length).toBeGreaterThanOrEqual(NOTIFICATION_KINDS.length);
  });
  it('no amount can travel in a notification', async () => {
    for (const key of ['amount', 'total', 'price', 'centimes', 'balance', 'figure'])
      await expect(notify('test', ['accountant'], { [key]: 1 }), key).rejects.toThrow();
  });
});

describe('who receives what', () => {
  it('an alert of the rules engine reaches the roles concerned, and only them', async () => {
    const subject = `s-${marker}`;
    const count = async (who: string, kind: string) => (await kindsOf(who, kind)).length;
    const before = {
      sales: await count('office_sales', 'receivable_overdue'),
      admin: await count('app_admin', 'receivable_overdue'),
    };
    await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, (tx) =>
      tx.query(
        `insert into alert (id, rule_id, subject_key, first_detected_on, created_by) values (gen_random_uuid(), 'RCV-OVERDUE', $1, '2026-11-02', $2)`,
        [subject, ownerId],
      ),
    );
    expect(await count('office_sales', 'receivable_overdue')).toBe(before.sales + 1);
    expect(await count('app_admin', 'receivable_overdue')).toBe(before.admin + 1);
    expect(await count('office_purchases', 'receivable_overdue')).toBe(0);
    expect(await count('plant_manager', 'receivable_overdue')).toBe(0);
    expect(await count('driver', 'receivable_overdue')).toBe(0);
    const n = (await kindsOf('office_sales', 'receivable_overdue'))[0]!;
    expect(JSON.stringify(n)).not.toMatch(/amount|centimes|total/);
  });
  it('a stock alert reaches the plant manager and the purchases office, not the sales office', async () => {
    await withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, (tx) =>
      tx.query(
        `insert into alert (id, rule_id, subject_key, first_detected_on, created_by) values (gen_random_uuid(), 'STOCK-LOW', $1, '2026-11-02', $2)`,
        [`k-${marker}`, ownerId],
      ),
    );
    expect((await kindsOf('plant_manager', 'stock_low')).length).toBe(1);
    expect((await kindsOf('office_purchases', 'stock_low')).length).toBe(1);
    expect((await kindsOf('office_sales', 'stock_low')).length).toBe(0);
  });
  it('an approval card notifies the owner and app_admin', async () => {
    const before = (await kindsOf('app_admin', 'approval_pending')).length;
    await notify('approval_pending', ['owner', 'app_admin'], { card: 'price' });
    expect((await kindsOf('app_admin', 'approval_pending')).length).toBe(before + 1);
    expect((await kindsOf('office_sales', 'approval_pending')).length).toBe(0);
  });
  it('a plant manager receives only what concerns their own plant', async () => {
    const other = await createPlant(app, u.owner!, { code: letters(6), name: `O ${marker}` });
    if (!other.ok) throw new Error(other.error);
    try {
      await notify('transfer', ['plant_manager'], { n: 1 }, other.value.id);
      expect((await kindsOf('plant_manager', 'transfer')).length).toBe(0);
      await notify('transfer', ['plant_manager'], { n: 2 }, plantId);
      expect((await kindsOf('plant_manager', 'transfer')).length).toBe(1);
    } finally {
      await updatePlant(app, u.owner!, other.value.id, { status: 'archived' });
    }
  });
});

describe('the centre is the person’s own', () => {
  it('counts, reads and marks only the caller’s rows', async () => {
    await sendTestNotification(app, u.office_sales!);
    const before = await unreadCount(app, u.office_sales!);
    expect(before).toBeGreaterThan(0);
    const adminBefore = await unreadCount(app, u.app_admin!);
    expect(await markRead(app, u.office_sales!, null)).toBe(before);
    expect(await unreadCount(app, u.office_sales!)).toBe(0);
    expect(await unreadCount(app, u.app_admin!)).toBe(adminBefore);
    // nobody can mark another person's notification by id
    const theirs = (await kindsOf('app_admin'))[0]!;
    expect(await markRead(app, u.office_sales!, [theirs.id])).toBe(0);
    expect(await markRead(app, u.office_sales!, ['not-a-uuid'] as never)).toBe(0);
  });
  it('a direct read of the table returns only the caller’s rows', async () => {
    await sendTestNotification(app, u.office_purchases!);
    const rows = await withRlsContext(
      app,
      { userId: u.office_purchases!.id, role: 'office_purchases', requestId: marker },
      (tx) => tx.query<{ recipient: string }>('select recipient::text from notification'),
    );
    expect(new Set(rows.rows.map((r) => r.recipient))).toEqual(new Set([u.office_purchases!.id]));
  });
});

describe('web push carries no content', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x!, 'base64url'),
    Buffer.from(pub.y!, 'base64url'),
  ]);
  const vapid = {
    publicKey: point.toString('base64url'),
    privateKey: priv.d!,
    subject: 'mailto:test@example.invalid',
  };

  it('refuses an endpoint that is not a browser push service (no server-side request to an arbitrary address)', async () => {
    const r = await saveSubscription(app, u.office_sales!, {
      endpoint: 'https://internal.example/hook',
      keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(12) },
    });
    expect(r).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await saveSubscription(app, u.office_sales!, {
        endpoint: 'http://web.push.apple.com/x',
        keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(12) },
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
  });
  it('signs a VAPID token the push service can verify', () => {
    const jwt = vapidJwt(vapid, 'https://web.push.apple.com', 1_800_000_000);
    const [h, b, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(b!, 'base64url').toString())).toMatchObject({
      aud: 'https://web.push.apple.com',
      sub: vapid.subject,
    });
    expect(Buffer.from(s!, 'base64url').length).toBe(64);
  });
  it('sends one empty wake-up per phone, marks the notifications pushed, drops a gone phone', async () => {
    const endpoint = `https://web.push.apple.com/${marker}`;
    const saved = await saveSubscription(app, u.office_purchases!, {
      endpoint,
      keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(12) },
    });
    expect(saved.ok).toBe(true);
    await sendTestNotification(app, u.office_purchases!);
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const first = await flushPush({ systemPool: system, vapid, fetch: fake });
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const mine = calls.find((c) => c.url === endpoint)!;
    expect(mine.init.body).toBeUndefined();
    expect(String((mine.init.headers as Record<string, string>).authorization)).toMatch(/^vapid t=.+, k=/);
    expect(String((mine.init.headers as Record<string, string>)['content-length'])).toBe('0');
    // nothing new: the second flush does not push this phone again
    calls.length = 0;
    await flushPush({ systemPool: system, vapid, fetch: fake });
    expect(calls.find((c) => c.url === endpoint)).toBeUndefined();
    // a phone the push service says is gone is removed
    await sendTestNotification(app, u.office_purchases!);
    const gone = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
    const out = await flushPush({ systemPool: system, vapid, fetch: gone });
    expect(out.removed).toBeGreaterThanOrEqual(1);
    expect(await dropSubscription(app, u.office_purchases!, endpoint)).toBe(false);
  });
  it('does nothing without a key pair', async () => {
    expect(await flushPush({ systemPool: system, vapid: null })).toEqual({ sent: 0, failed: 0, removed: 0 });
  });
  it('the sender doors answer the system role only', async () => {
    await expect(
      withRlsContext(app, { userId: u.office_sales!.id, role: 'office_sales', requestId: marker }, (tx) =>
        tx.query('select * from public.push_outbox(10)'),
      ),
    ).rejects.toThrow();
  });
});
