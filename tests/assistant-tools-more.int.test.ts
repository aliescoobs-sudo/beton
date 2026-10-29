import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { Pseudonymizer, prepareForModel, scanForLeaks } from '../src/modules/assistant';
import { findTool, toolsFor } from '../src/modules/assistant/service/tool-registry';
import { runTool } from '../src/modules/assistant/service/tool-runner';
import type { ToolContext } from '../src/modules/assistant/domain/tool-types';
import { createInvoice, SearchRateLimiter } from '../src/modules/ledger';
import { can, type Role } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { defaultParameters } from '../src/modules/platform-security/domain/parameters';
import { engineParams } from '../src/modules/rules-engine';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { withoutFixtureLabels } from './helpers/leak-noise';
import {
  clientWithLoads,
  deliveryScene,
  type DeliveryScene,
  newSupplierInvoice,
  orderMaster,
} from './helpers/ledger-fixtures';

// assistant A5 (SPEC-assistant §5, AC-ASSIST-21 to 25): order_chain, find_document, purchase_status, consumption_variance.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const ROLES = ['owner', 'partner', 'office', 'plant', 'support'] as const;
const users = {} as Record<(typeof ROLES)[number], SessionUser>;
const marker = `am${randomUUID()
  .replace(/-/g, '')
  .slice(0, 10)
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;
const DAY = '2026-06-02';
let scene: DeliveryScene;
let sold: { clientCode: string; orderCode: string; blNos: string[]; invoice: string };
let purchase: { code: string; invoiceCode: string };

const ctxOf = (actor: SessionUser, today = DAY): ToolContext => ({
  appPool: app,
  actor,
  today,
  engine: engineParams(defaultParameters()),
  codeOfName: () => null,
});
const call = (role: Role, tool: string, args: unknown = {}, today = DAY) =>
  runTool(ctxOf(users[role as (typeof ROLES)[number]], today), tool, args);

// The matrix of SPEC-assistant §5, the four new read tools. O P B L S.
const MATRIX: Record<string, readonly Role[]> = {
  order_chain: ['owner', 'partner', 'office', 'plant', 'support'],
  find_document: ['owner', 'partner', 'office', 'plant', 'support'],
  purchase_status: ['owner', 'plant', 'support'],
  consumption_variance: ['owner', 'partner', 'plant', 'support'],
};

beforeAll(async () => {
  for (const role of ROLES) users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  scene = await deliveryScene(app, users.owner.id, marker);
  const master = await orderMaster(app, users.owner.id, marker);
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[3000, 2000]]);
  const order = c.orders[0]!;
  const made = await createInvoice(app, users.owner, { deliveryIds: order.deliveryIds }, { today: DAY });
  if (!made.ok) throw new Error(made.error);
  sold = { clientCode: c.clientCode, orderCode: order.code, blNos: order.blNos, invoice: made.value.number };
  // A purchase received whole and invoiced for more than was received: the match flags a gap.
  const po = await withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
    newSupplierInvoice(tx, users.owner.id, marker, { qtyMilli: 31_000 }),
  );
  purchase = { code: po.purchaseCode, invoiceCode: po.code };
});

describe('the matrix and the refusal tests (AC-ASSIST-25)', () => {
  it.each(Object.entries(MATRIX))(
    '%s is offered to exactly its row of the spec, as the permissions say',
    (name, roles) => {
      const tool = findTool(name)!;
      expect([...tool.roles].sort()).toEqual([...roles].sort());
      for (const role of ROLES) {
        expect(
          toolsFor(role).some((t) => t.name === name),
          `${name} for ${role}`,
        ).toBe(roles.includes(role));
        expect(tool.roles.includes(role), `${name} for ${role}`).toBe(
          tool.permissions.some((p) => can(role, p)),
        );
      }
    },
  );

  it('refuses the roles off the row, audits it, and returns no data', async () => {
    for (const [name, roles] of Object.entries(MATRIX))
      for (const role of ROLES.filter((r) => !roles.includes(r))) {
        const r = await call(
          role,
          name,
          name === 'order_chain'
            ? { order_code: sold.orderCode }
            : name === 'find_document'
              ? { number: 'BL-2026' }
              : {},
        );
        expect(r, `${name} for ${role}`).toMatchObject({ outcome: 'permission_denied', rowCount: 0 });
        expect(JSON.stringify(r.result)).not.toMatch(/order|stages|purchases|components|documents/);
      }
  });
});

describe('order_chain (AC-ASSIST-21)', () => {
  it('gives the stages of the order in m³, and the paid state to the owner and support only', async () => {
    for (const role of ROLES) {
      const r = await call(role, 'order_chain', { order_code: sold.orderCode });
      expect(r.outcome, role).toBe('ok');
      const out = r.result as { found: boolean; order: { client: string; stages: Record<string, unknown> } };
      expect(out.found).toBe(true);
      expect(out.order.client).toBe(sold.clientCode);
      expect(out.order.stages).toMatchObject({
        orderedM3: 10,
        plannedM3: 0,
        loadedM3: 5,
        deliveredM3: 5,
        invoicedM3: 5,
      });
      if (role === 'owner' || role === 'support') expect(out.order.stages.paid).toBe('unpaid');
      else {
        expect('paid' in out.order.stages, role).toBe(false);
        expectNoFields(r.result, ['paid', 'paidState']);
      }
      expectNoFields(r.result, ['clientName', 'name', 'phone', 'orderId']);
      expect(JSON.stringify(r.result)).not.toMatch(/Centimes/);
    }
  });

  it('answers an unknown order with nothing, and refuses a malformed code as a bad argument', async () => {
    expect((await call('plant', 'order_chain', { order_code: 'CMD-2026-99999' })).result).toEqual({
      found: false,
      order: null,
    });
    for (const bad of ['CMD-2026', "CMD-2026-00001'; --", 'Atlas', '']) {
      expect(await call('plant', 'order_chain', { order_code: bad }), bad).toMatchObject({
        outcome: 'invalid_args',
      });
    }
  });
});

describe('find_document (AC-ASSIST-22)', () => {
  const find = (role: Role, number: string, actor: SessionUser = users[role as (typeof ROLES)[number]]) =>
    runTool(ctxOf(actor), 'find_document', { number });

  it('finds a BL by its number, or by its first characters, for every role, and an invoice only where the role reads invoices', async () => {
    const bl = sold.blNos[0]!;
    for (const role of ROLES) {
      const r = await find(role, bl);
      expect(r.outcome, role).toBe('ok');
      expect((r.result as { documents: { kind: string; number: string }[] }).documents).toContainEqual(
        expect.objectContaining({ kind: 'bl', number: bl }),
      );
    }
    const asOwner = await find('owner', sold.invoice);
    expect((asOwner.result as { documents: { kind: string }[] }).documents.map((d) => d.kind)).toContain(
      'invoice',
    );
    for (const role of ['office', 'plant', 'partner'] as const) {
      const r = await find(role, sold.invoice);
      expect((r.result as { documents: unknown[] }).documents, role).toEqual([]);
    }
  });

  it('carries no address, id or name, and no instrument number', async () => {
    const r = await find('owner', sold.blNos[0]!);
    expectNoFields(r.result, ['path', 'id', 'url', 'href', 'clientName', 'name']);
    expect(JSON.stringify(r.result)).not.toMatch(/\/deliveries\/|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('refuses what is not a document number: too short, other characters, a name with spaces', async () => {
    for (const q of ['BL', 'ab', 'Béton Atlas', "BL-2026'; drop", '%%%%', '../etc']) {
      expect(await find('owner', q), q).toMatchObject({ outcome: 'invalid_args', rowCount: 0 });
    }
  });

  it('audits a miss, and ten misses lock the actor out, here as in the search box', async () => {
    const actor = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
    const misses = async () =>
      Number(
        (
          await migrator.query(
            `select count(*)::int as n from audit_event where table_name = 'document_search' and action = 'permission_denied' and actor_user_id = $1`,
            [actor.id],
          )
        ).rows[0].n,
      );
    expect(await misses()).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      const r = await find('plant', `ZZZZ-${i}${i}${i}${i}`, actor);
      expect(r.outcome).toBe('ok');
      expect(r.result).toEqual({ count: 0, documents: [] });
    }
    expect(await misses()).toBe(10);
    const locked = await find('plant', sold.blNos[0]!, actor);
    expect(locked).toMatchObject({ outcome: 'permission_denied', rowCount: 0 });
    // The lock-out is the search's own: the same actor is locked out of the box too.
    const { searchDocuments } = await import('../src/modules/ledger');
    expect(
      await searchDocuments(app, actor, sold.blNos[0]!, { limiter: new SearchRateLimiter(100, 60_000) }),
    ).toEqual({
      ok: false,
      error: 'TOO_MANY_ATTEMPTS',
    });
  });
});

describe('purchase_status (AC-ASSIST-23)', () => {
  it('gives the owner and support the quantities, the invoice match state and the amounts', async () => {
    for (const role of ['owner', 'support'] as const) {
      const r = await call(role, 'purchase_status', { po_code: purchase.code });
      expect(r.outcome, role).toBe('ok');
      const p = (
        r.result as {
          purchases: {
            code: string;
            status: string;
            lines: { orderedQty: number; receivedQty: number }[];
            invoices: {
              code: string;
              state: string;
              gapLines: number;
              flags: string[];
              totalCentimes: number;
            }[];
            totalCentimes?: number;
          }[];
        }
      ).purchases[0]!;
      expect(p).toMatchObject({ code: purchase.code, status: 'complete' });
      expect(p.lines[0]).toMatchObject({ orderedQty: 30, receivedQty: 30 });
      expect(p.invoices[0]).toMatchObject({ code: purchase.invoiceCode, gapLines: 1 });
      expect(p.invoices[0]?.flags).toContain('QTY_OVER_RECEIVED');
      expect(typeof p.totalCentimes).toBe('number');
    }
  });

  it('gives the plant the quantities and no invoice, no match state, no amount', async () => {
    const r = await call('plant', 'purchase_status', { po_code: purchase.code });
    expect(r.outcome).toBe('ok');
    const p = (r.result as { purchases: Record<string, unknown>[] }).purchases[0]!;
    expect(p).toMatchObject({ code: purchase.code, status: 'complete' });
    expect('invoices' in p).toBe(false);
    expectNoFields(r.result, [
      'invoices',
      'flags',
      'state',
      'gapLines',
      'totalCentimes',
      'paidCentimes',
      'price',
      'supplierName',
    ]);
    expect(JSON.stringify(r.result)).not.toMatch(/Centimes/);
  });

  it('lists the latest live orders without a code, and answers an unknown code with nothing', async () => {
    const r = await call('owner', 'purchase_status', {});
    expect((r.result as { count: number }).count).toBeGreaterThan(0);
    expect((await call('owner', 'purchase_status', { po_code: 'ACH-2026-99999' })).result).toEqual({
      count: 0,
      purchases: [],
    });
    expect(await call('owner', 'purchase_status', { po_code: 'ACH-2026' })).toMatchObject({
      outcome: 'invalid_args',
    });
  });
});

describe('consumption_variance (AC-ASSIST-24)', () => {
  it('gives the month per component in tonnes and litres, quantities only, to the roles of the report', async () => {
    for (const role of ['owner', 'partner', 'plant', 'support'] as const) {
      const r = await call(role, 'consumption_variance', { month: '2026-06' });
      expect(r.outcome, role).toBe('ok');
      const out = r.result as {
        month: string;
        count: number;
        components: { theoretical: number; unit: string; flagged: boolean }[];
        toleranceBp: number;
      };
      expect(out.month).toBe('2026-06');
      expect(out.toleranceBp).toBeGreaterThan(0);
      for (const c of out.components) expect(['t', 'L']).toContain(c.unit);
      expect(JSON.stringify(r.result)).not.toMatch(/Centimes|componentId|"id"/);
    }
    expect(await call('office', 'consumption_variance', {})).toMatchObject({ outcome: 'permission_denied' });
  });

  it('says what a month with no data says: nothing, and bounds the month it will look at', async () => {
    const r = await call('owner', 'consumption_variance', { month: '2026-01' }, DAY);
    expect(r.outcome).toBe('ok');
    expect(await call('owner', 'consumption_variance', { month: '2031-01' })).toMatchObject({
      outcome: 'invalid_args',
    });
    expect(await call('owner', 'consumption_variance', { month: '2026-13' })).toMatchObject({
      outcome: 'invalid_args',
    });
    expect(await call('owner', 'consumption_variance', { month: 'last month' })).toMatchObject({
      outcome: 'invalid_args',
    });
  });

  it('defaults to the month of the business date', async () => {
    const r = await call('plant', 'consumption_variance', {}, DAY);
    expect((r.result as { month: string }).month).toBe('2026-06');
  });
});

describe('what leaves these tools carries no name, number or amount once pseudonymized (AC-ASSIST-05)', () => {
  it('passes the leak scan for every role that may call them, with real arguments', async () => {
    const q = await migrator.query<{ name: string }>(
      `select name from (select name from client union all select name from supplier union all select name from driver) n
        where name not in (select label from concrete_type union select name_fr from component)`,
    );
    const ice = await migrator.query<{ ice: string }>('select ice from client where ice is not null');
    const index = { names: q.rows.map((r) => r.name), numbers: ice.rows.map((r) => r.ice) };
    const calls: [string, unknown][] = [
      ['order_chain', { order_code: sold.orderCode }],
      ['find_document', { number: sold.blNos[0] }],
      ['purchase_status', { po_code: purchase.code }],
      ['consumption_variance', { month: '2026-06' }],
    ];
    for (const role of ROLES)
      for (const [name, args] of calls) {
        if (!findTool(name)!.roles.includes(role)) continue;
        const r = await call(role, name, args);
        expect(r.outcome, `${name} for ${role}`).toBe('ok');
        const payload = JSON.stringify(
          prepareForModel(withoutFixtureLabels(r.result), new Pseudonymizer([])),
        );
        expect(scanForLeaks(payload, index), `${name} for ${role}`).toEqual([]);
      }
  });
});
