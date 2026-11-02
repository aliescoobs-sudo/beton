import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { Pseudonymizer, prepareForModel, scanForLeaks } from '../src/modules/assistant';
import { draftToolsFor } from '../src/modules/assistant/service/drafts/registry';
import { findTool, TOOLS, toolSpecsFor, toolsFor } from '../src/modules/assistant/service/tool-registry';
import { runTool } from '../src/modules/assistant/service/tool-runner';
import type { ToolContext } from '../src/modules/assistant/domain/tool-types';
import { createInvoice } from '../src/modules/ledger';
import { saveDispatch } from '../src/modules/operations';
import { can, type Role } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { defaultParameters } from '../src/modules/platform-security/domain/parameters';
import { engineParams } from '../src/modules/rules-engine';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { withoutFixtureLabels } from './helpers/leak-noise';
import { clientWithLoads, deliveryScene, type DeliveryScene, orderMaster } from './helpers/ledger-fixtures';

// assistant A4 (SPEC-assistant §5, AC-ASSIST-03, 04): the first six read tools. The matrix of the spec, the role check at call
// time, the output allow-lists, the restricted views and the refusal tests.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const ROLES = ['owner', 'partner', 'office', 'plant', 'support'] as const;
const users = {} as Record<(typeof ROLES)[number], SessionUser>;
// No digit in the marker: fixture labels are built from it, and a run of six digits in a payload is a leak by rule.
const marker = `at${randomUUID()
  .replace(/-/g, '')
  .slice(0, 10)
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;
const DAY = '2026-06-02';
// The day of the plan of this suite: far away, so that no other suite's rotation is on it.
const ROT_DAY = '2098-05-05';
let scene: DeliveryScene;
let planClient: { name: string; code: string };
let sold: { name: string; code: string; blNos: string[]; invoice?: string };
const names = new Map<string, string>();

const ctxOf = (role: keyof typeof users, today = DAY): ToolContext => ({
  appPool: app,
  actor: users[role],
  today,
  engine: engineParams(defaultParameters()),
  codeOfName: (n) => names.get(n) ?? null,
});
const call = (role: keyof typeof users, tool: string, args: unknown = {}, today = DAY) =>
  runTool(ctxOf(role, today), tool, args);
const ROTATION_TOOLS = ['deliveries_today', 'next_load'];
const callOn = (role: keyof typeof users, tool: string, args: unknown = {}) =>
  call(role, tool, args, ROTATION_TOOLS.includes(tool) ? ROT_DAY : DAY);
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

// The matrix of SPEC-assistant §5, first six tools. O P B L S.
const MATRIX: Record<string, readonly Role[]> = {
  deliveries_today: ['owner', 'partner', 'office', 'plant', 'support'],
  stock_and_cover: ['owner', 'partner', 'plant', 'support'],
  uninvoiced_bls: ['owner', 'office', 'support'],
  open_invoices: ['owner', 'support'],
  forecast: ['owner', 'support'],
  next_load: ['owner', 'partner', 'office', 'plant', 'support'],
};

beforeAll(async () => {
  for (const role of ROLES) users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  scene = await deliveryScene(app, users.owner.id, marker, ROT_DAY);
  const who = await inCtx(users.owner, (tx) =>
    tx.query<{ name: string; code: string }>('select c.name, c.code from client c where c.id = $1', [
      scene.clientId,
    ]),
  );
  planClient = who.rows[0]!;
  names.set(planClient.name, planClient.code);
  const saved = await saveDispatch(app, users.plant, {
    date: ROT_DAY,
    rotations: [{ orderId: scene.orderId, truckId: scene.truckId, driverId: null, volumeL: 2000 }],
  });
  if (!saved.ok) throw new Error(saved.error);

  const master = await orderMaster(app, users.owner.id, marker);
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[3000, 2000]]);
  const nm = await inCtx(users.owner, (tx) =>
    tx.query<{ name: string }>('select name from client where id = $1', [c.clientId]),
  );
  sold = { name: nm.rows[0]!.name, code: c.clientCode, blNos: c.orders[0]!.blNos };
  names.set(sold.name, sold.code);
});

describe('the matrix (AC-ASSIST-03)', () => {
  it.each(Object.entries(MATRIX))('%s is offered to exactly its row of the spec', (name, roles) => {
    expect([...(findTool(name)?.roles ?? [])].sort()).toEqual([...roles].sort());
    for (const role of ROLES)
      expect(
        toolsFor(role).some((t) => t.name === name),
        `${name} for ${role}`,
      ).toBe(roles.includes(role));
  });

  it('agrees with the permissions of the screens: a role is on the row exactly when it holds one of them', () => {
    for (const tool of TOOLS)
      for (const role of ROLES)
        expect(tool.roles.includes(role), `${tool.name} for ${role}`).toBe(
          tool.permissions.some((p) => can(role, p)),
        );
  });

  it('sends the model only the tools of the role, each with a closed schema', () => {
    for (const role of ROLES) {
      const specs = toolSpecsFor(role);
      expect(specs.map((s) => s.name).sort()).toEqual(
        [...toolsFor(role), ...draftToolsFor(role)].map((t) => t.name).sort(),
      );
      for (const s of specs)
        expect(s.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('refuses a call outside the row, audits it and returns no data', async () => {
    for (const [name, roles] of Object.entries(MATRIX)) {
      for (const role of ROLES.filter((r) => !roles.includes(r))) {
        const before = Number(
          (
            await migrator.query(
              `select count(*)::int as n from audit_event where table_name = 'assistant_tool' and actor_user_id = $1 and reason = $2`,
              [users[role].id, name],
            )
          ).rows[0].n,
        );
        const r = await call(role, name);
        expect(r, `${name} for ${role}`).toMatchObject({ outcome: 'permission_denied', rowCount: 0 });
        expect(JSON.stringify(r.result)).not.toMatch(/"count"|rotations|invoices|clients|components/);
        const after = Number(
          (
            await migrator.query(
              `select count(*)::int as n from audit_event where table_name = 'assistant_tool' and actor_user_id = $1 and reason = $2`,
              [users[role].id, name],
            )
          ).rows[0].n,
        );
        expect(after, `${name} for ${role}`).toBe(before + 1);
      }
    }
  });

  it('refuses a tool that is not in the catalogue: confirming, writing, another role’s tools', async () => {
    for (const name of ['confirm_proposal', 'delete_invoice', 'sql', 'run_service', 'OPEN_INVOICES ']) {
      expect(await call('owner', name, { id: 'x' })).toMatchObject({ outcome: 'permission_denied' });
    }
  });

  it('refuses arguments outside the typed bounds', async () => {
    for (const [tool, args] of [
      ['deliveries_today', { date: '2031-01-01' }],
      ['deliveries_today', { date: "2026-06-02'; drop table client; --" }],
      ['deliveries_today', { date: DAY, as: 'owner' }],
      ['next_load', { client: 'Béton Atlas' }],
      ['uninvoiced_bls', { client: 'CLT-1; select' }],
      ['forecast', { days: 400 }],
      ['open_invoices', { client: 'x'.repeat(5000) }],
    ] as const) {
      expect(await call('owner', tool, args), `${tool} ${JSON.stringify(args)}`).toMatchObject({
        outcome: 'invalid_args',
        rowCount: 0,
      });
    }
  });
});

describe('deliveries_today and next_load', () => {
  it('give every role the day’s rotation, in codes and m³, and no name, plate, driver, site or order', async () => {
    for (const role of ROLES) {
      const r = await call(role, 'deliveries_today', { date: ROT_DAY }, ROT_DAY);
      expect(r.outcome, role).toBe('ok');
      const rows = (r.result as { rotations: { client: string; m3: number; step: string; truck: string }[] })
        .rotations;
      const mine = rows.find((x) => x.client === planClient.code);
      expect(mine, role).toMatchObject({ m3: 2, step: 'planned', bl: null });
      expect(mine?.truck).toMatch(/^T\d+$/);
      expectNoFields(r.result, [
        'driverName',
        'truckPlate',
        'plate',
        'clientName',
        'name',
        'siteLabel',
        'zoneName',
        'orderCode',
        'orderId',
        'phone',
        'priceCentimes',
        'unitPriceHtCentimes',
      ]);
      expect(JSON.stringify(r.result)).not.toContain(planClient.name);
    }
  });

  it('office gets its restricted view: the same facts, from the database function that returns no order and no price', async () => {
    const r = await call('office', 'deliveries_today', { date: ROT_DAY }, ROT_DAY);
    expect(r.outcome).toBe('ok');
    expect(JSON.stringify(r.result)).not.toMatch(/CMD-|Centimes/);
  });

  it('next_load finds the next planned rotation, by client or by truck, and says when there is none', async () => {
    for (const role of ROLES) {
      const any = await call(role, 'next_load', {}, ROT_DAY);
      expect(any.outcome, role).toBe('ok');
    }
    const t = (await call('plant', 'deliveries_today', { date: ROT_DAY }, ROT_DAY)).result as {
      rotations: { client: string; truck: string }[];
    };
    const mine = t.rotations.find((x) => x.client === planClient.code)!;
    // `today` of the context is the plan day, so the plan is "today".
    const byClient = await call('plant', 'next_load', { client: planClient.code }, ROT_DAY);
    expect(byClient.result).toMatchObject({
      found: true,
      rotation: { client: planClient.code, truck: mine.truck },
    });
    const byTruck = await call('office', 'next_load', { truck: mine.truck.toLowerCase() }, ROT_DAY);
    expect(byTruck.result).toMatchObject({ found: true });
    expect((await call('plant', 'next_load', { truck: 'ZZ99' }, ROT_DAY)).result).toEqual({
      found: false,
      rotation: null,
    });
    expect((await call('plant', 'next_load', { client: 'CLT-999999' }, ROT_DAY)).result).toEqual({
      found: false,
      rotation: null,
    });
  });
});

describe('stock_and_cover (AC-ASSIST-04)', () => {
  it('gives stock and days of cover to the roles that read the stock and nothing about suppliers, prices or drafts', async () => {
    for (const role of ['owner', 'partner', 'plant', 'support'] as const) {
      const r = await call(role, 'stock_and_cover');
      expect(r.outcome, role).toBe('ok');
      const out = r.result as {
        count: number;
        components: { nameFr: string; unit: string; level: number }[];
      };
      expect(out.count).toBeGreaterThan(0);
      expect(out.components[0]).toHaveProperty('unit');
      expectNoFields(r.result, [
        'supplier',
        'supplierCode',
        'supplierName',
        'price',
        'draft',
        'lastPrice',
        'unitPriceHtCentimes',
      ]);
      expect(JSON.stringify(r.result)).not.toMatch(/Centimes/);
    }
    expect(await call('office', 'stock_and_cover')).toMatchObject({ outcome: 'permission_denied' });
  });
});

describe('uninvoiced_bls', () => {
  it('gives the owner and support the BLs with amounts, and office the same BLs with no money key at all', async () => {
    for (const role of ['owner', 'support'] as const) {
      const r = await call(role, 'uninvoiced_bls', { client: sold.code });
      expect(r.outcome, role).toBe('ok');
      const c = (
        r.result as {
          clients: {
            client: string;
            blCount: number;
            totalM3: number;
            bls: { bl: string; m3: number; amountHtCentimes?: number }[];
            ttcCentimes?: number;
          }[];
        }
      ).clients[0]!;
      expect(c).toMatchObject({ client: sold.code, blCount: 2, totalM3: 5 });
      expect(c.bls.map((b) => b.bl).sort()).toEqual([...sold.blNos].sort());
      expect(c.bls.every((b) => typeof b.amountHtCentimes === 'number')).toBe(true);
      expect(typeof c.ttcCentimes).toBe('number');
    }
    const o = await call('office', 'uninvoiced_bls', { client: sold.code });
    expect(o.outcome).toBe('ok');
    expect(JSON.stringify(o.result)).not.toMatch(/Centimes|amount|price|ttc/i);
    const row = (o.result as { clients: { bls: { bl: string; product: string; m3: number }[] }[] })
      .clients[0]!;
    expect(row.bls.map((b) => b.bl).sort()).toEqual([...sold.blNos].sort());
    expect(row.bls[0]).toHaveProperty('product');
    expect(row.bls[0]).toHaveProperty('m3');
  });

  it('leaves out another client when one is asked for, and an unknown client gives an empty answer', async () => {
    const all = await call('owner', 'uninvoiced_bls', {});
    expect((all.result as { count: number }).count).toBeGreaterThanOrEqual(1);
    const none = await call('owner', 'uninvoiced_bls', { client: 'CLT-999999' });
    expect(none.result).toEqual({ count: 0, clients: [] });
  });
});

describe('open_invoices and forecast (owner and support only)', () => {
  it('lists the open invoice with what is paid and what remains, in centimes the model will only see as placeholders', async () => {
    const made = await createInvoice(
      app,
      users.owner,
      { deliveryIds: await deliveryIdsOf(sold.blNos) },
      { today: DAY },
    );
    if (!made.ok) throw new Error(made.error);
    sold.invoice = made.value.number;
    for (const role of ['owner', 'support'] as const) {
      const r = await call(role, 'open_invoices', { client: sold.code });
      expect(r.outcome, role).toBe('ok');
      const inv = (
        r.result as {
          invoices: {
            number: string;
            client: string;
            totalCentimes: number;
            paidCentimes: number;
            openCentimes: number;
            overdue: boolean;
          }[];
        }
      ).invoices[0]!;
      expect(inv).toMatchObject({ number: sold.invoice, client: sold.code, paidCentimes: 0, overdue: false });
      expect(inv.openCentimes).toBe(inv.totalCentimes);
    }
    for (const role of ['office', 'plant', 'partner'] as const)
      expect(await call(role, 'open_invoices'), role).toMatchObject({
        outcome: 'permission_denied',
        rowCount: 0,
      });
  });

  it('gives the engine’s forecast as it states it, to the owner and support only', async () => {
    for (const role of ['owner', 'support'] as const) {
      const r = await call(role, 'forecast', { days: 3 });
      expect(r.outcome, role).toBe('ok');
      const out = r.result as { days: unknown[]; horizonDays: number };
      expect(out.days.length).toBeLessThanOrEqual(3);
      expect(out.horizonDays).toBeGreaterThan(0);
      expectNoFields(r.result, ['partyName', 'causes', 'events', 'params', 'label']);
    }
    for (const role of ['office', 'plant', 'partner'] as const)
      expect(await call(role, 'forecast'), role).toMatchObject({ outcome: 'permission_denied' });
  });

  it('writes nothing: the forecast of the owner stores no alert', async () => {
    const count = async () =>
      Number((await migrator.query('select count(*)::int as n from alert')).rows[0].n);
    const before = await count().catch(() => -1);
    await call('owner', 'forecast');
    expect(await count().catch(() => -1)).toBe(before);
  });
});

describe('what leaves a tool carries no name, number or amount once pseudonymized (AC-ASSIST-05)', () => {
  it('passes the leak scan for every tool and every role on the demo data', async () => {
    const index = await leakIndex();
    for (const role of ROLES) {
      const ps = new Pseudonymizer([]);
      for (const tool of toolsFor(role)) {
        const r = await callOn(role, tool.name, {});
        const payload = JSON.stringify(prepareForModel(withoutFixtureLabels(r.result), ps));
        const hits = scanForLeaks(payload, index);
        expect(hits, `${tool.name} for ${role}`).toEqual([]);
      }
    }
  });
});

async function deliveryIdsOf(blNos: string[]): Promise<string[]> {
  const { rows } = await migrator.query<{ id: string }>('select id from delivery where bl_no = any($1)', [
    blNos,
  ]);
  return rows.map((r) => r.id);
}

async function leakIndex() {
  // Names other suites gave both to a supplier and to a component (or a product) are one word for the check: left out.
  const q = await migrator.query<{ name: string }>(
    `select name from (
        select name from client union all select name from supplier union all select name from driver
        union all select plate from truck where plate is not null
      ) n
      where name not in (select label from concrete_type union select name_fr from component)`,
  );
  const ice = await migrator.query<{ ice: string }>(`select ice from client where ice is not null`);
  return { names: q.rows.map((r) => r.name), numbers: ice.rows.map((r) => r.ice) };
}
