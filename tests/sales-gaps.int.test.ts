import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { readSheet } from '../src/modules/importer';
import { runImport } from '../src/modules/importer/service/importers';
import {
  addClientAlias,
  createOrder,
  getClientTerms,
  listClientAliases,
  listInstruments,
  listOrderExtras,
  listPoRequiredClientIds,
  setClientTerms,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import type { Role } from '../src/modules/platform-security/domain/permissions';
import { testEnv } from './db-env';
import { orderMaster } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';
import { buildXlsx } from './helpers/xlsx-writer';

// T19 item 4 (migrations 0247, 0248): the client PO number and the commercial on the order, the client aliases, the per-client terms.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const marker = `sg_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let ids = {} as Record<Role, string>;
let done: () => Promise<void>;
let clientId = '';
let typeId = '';
const TODAY = '2026-12-02';
const user = (role: Role) => ({ id: ids[role], role }) as unknown as SessionUser;
beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  ids = v.ids;
  done = v.done;
  const m = await orderMaster(app, ids.owner, marker);
  clientId = m.clientId;
  typeId = m.typeId;
});
afterAll(async () => {
  await done();
  await app.end();
});

const order = (role: Role, extra: Record<string, unknown> = {}) =>
  createOrder(
    app,
    user(role),
    {
      clientId,
      concreteTypeId: typeId,
      dischargeMethod: 'GOULOTTE',
      volumeL: 5000,
      deliveryDate: '2026-12-10',
      plan: { preset: 'cash' },
      ...extra,
    },
    { today: TODAY },
  );

describe('the client PO number and the commercial', () => {
  it('an order keeps its PO and commercial; the BL and invoice read them by id or by code', async () => {
    const r = await order('office_sales', { clientPo: `BC-${marker}`, commercial: 'Responsable' });
    expect(r.ok).toBe(true);
    const created = (r as { ok: true; value: { id: string; code: string } }).value;
    const extra = (await listOrderExtras(app, user('owner'), [created.id])).get(created.id);
    expect(extra).toMatchObject({ clientPo: `BC-${marker}`, commercial: 'Responsable' });
    const byCode = await withRlsContext(
      app,
      { userId: ids.plant_manager, role: 'plant_manager' as never, requestId: marker },
      (tx) => tx.query(`select * from public.order_client_pos($1::text[])`, [[created.code]]),
    );
    expect(byCode.rows).toEqual([{ o_code: created.code, o_client_po: `BC-${marker}` }]);
    // an order with neither writes nothing and is still fine when the client does not require a PO
    expect((await order('owner')).ok).toBe(true);
  });

  it('a client flagged "PO required" cannot have an order without its PO, on either path; with it the order is made', async () => {
    const set = await setClientTerms(app, user('office_sales'), {
      clientId,
      poRequired: true,
      priceBasis: 'TTC',
    });
    expect(JSON.stringify(set)).toBe('{"ok":true,"value":true}');
    expect(await getClientTerms(app, user('owner'), clientId)).toEqual({
      poRequired: true,
      priceBasis: 'TTC',
    });
    // the order form learns it before the person saves: the flag is readable by the order-entry roles
    for (const role of ['office_sales', 'owner'] as const)
      expect(await listPoRequiredClientIds(app, user(role))).toContain(clientId);
    expect(await order('office_sales')).toEqual({ ok: false, error: 'PO_REQUIRED' }); // blind path
    expect(await order('owner')).toEqual({ ok: false, error: 'PO_REQUIRED' }); // owner path
    expect((await order('office_sales', { clientPo: `BC2-${marker}` })).ok).toBe(true);
    expect((await order('owner', { clientPo: `BC3-${marker}` })).ok).toBe(true);
    // nothing was left behind by the refused orders
    const n = await withRlsContext(app, { userId: ids.owner, role: 'owner', requestId: marker }, (tx) =>
      tx.query(`select count(*)::int n from sales_order where client_id = $1`, [clientId]),
    );
    expect(n.rows[0].n).toBe(4); // two earlier + two with a PO
    expect(
      (await setClientTerms(app, user('owner'), { clientId, poRequired: false, priceBasis: 'HT' })).ok,
    ).toBe(true);
    expect(await listPoRequiredClientIds(app, user('owner'))).not.toContain(clientId);
  });

  it("who may set the terms; a bad basis is refused; set_order_extra only for the caller's own order", async () => {
    await expect(
      setClientTerms(app, user('plant_manager'), { clientId, poRequired: true, priceBasis: 'HT' }),
    ).rejects.toThrow();
    expect(
      (await setClientTerms(app, user('owner'), { clientId, poRequired: false, priceBasis: 'EUR' })).ok,
    ).toBe(false);
    const mine = (await order('owner')) as { ok: true; value: { id: string } };
    await expect(
      withRlsContext(
        app,
        { userId: ids.office_sales, role: 'office_sales' as never, requestId: marker },
        (tx) => tx.query(`select public.set_order_extra($1, 'X', 'Y')`, [mine.value.id]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('client aliases', () => {
  it("maps alternate names to one client, unique, never another client's name, and the importer finds the client by an alias", async () => {
    const alias = `Atlas Bât. ${marker}`;
    expect((await addClientAlias(app, user('office_sales'), { clientId, alias })).ok).toBe(true);
    expect((await listClientAliases(app, user('office_purchases'), clientId)).map((a) => a.alias)).toEqual([
      alias,
    ]);
    expect((await addClientAlias(app, user('owner'), { clientId, alias: alias.toUpperCase() })).ok).toBe(
      false,
    ); // unique, any case
    // the exact name of another client is refused
    const other = await withRlsContext(
      app,
      { userId: ids.owner, role: 'owner', requestId: marker },
      async (tx) =>
        (
          await tx.query<{ id: string; name: string }>(`select id, name from client where id <> $1 limit 1`, [
            clientId,
          ])
        ).rows[0],
    );
    if (other)
      expect((await addClientAlias(app, user('owner'), { clientId, alias: other.name })).ok).toBe(false);
    await expect(
      addClientAlias(app, user('plant_manager'), { clientId, alias: 'Zzz Zzz' }),
    ).rejects.toThrow();
    // the importer resolves a cheque written under the alias
    const number = `AL${marker.slice(3)}`;
    const rows = [
      ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
      [alias, 'chèque', number, 'BMCE', '1 000,00', '2026-11-20'],
    ];
    const real = await runImport('cheques_in_transit', readSheet(buildXlsx(rows)), {
      appPool: app,
      actor: user('owner'),
      apply: true,
    });
    expect(real.counts).toMatchObject({ created: 1, error: 0 });
    const mine = (await listInstruments(app, user('owner'))).find((i) => i.number === number);
    expect(mine?.partyId).toBe(clientId);
  });
});
