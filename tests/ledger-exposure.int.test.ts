import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { OWNER_2FA_RESET_DETAIL } from '../src/modules/platform-security/service/break-glass';
import { testEnv } from './db-env';
import { realActor, type TestActor } from './helpers/actors';
import { insertOrder, orderMaster, type OrderMaster } from './helpers/ledger-fixtures';

// DECISIONS 81: what office, partner and plant can reach (views, functions, error messages, row counts, RETURNING,
// planner statistics) shows no price, total, plan or amount. The seeded order carries amounts that are easy to spot.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end(), systemPool.end()]));

const marker = `expo_${randomUUID().replace(/-/g, '')}`;
const actors = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', TestActor>;
const inCtx = <T>(role: string, userId: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId, role: role as never, requestId: marker }, fn);
const as = <T>(role: keyof typeof actors, fn: (tx: pg.PoolClient) => Promise<T>) =>
  inCtx(role, actors[role].id, fn);

/** The amounts of the fixture order: unit price, HT, VAT, TTC (centimes) and TTC in dirhams. */
const AMOUNTS = /\b(78000|780000|156000|936000|9360|7800|1560)\b/;
const leaks = (value: unknown) => AMOUNTS.test(JSON.stringify(value) ?? '');
const errorText = (e: unknown) => {
  const x = e as Record<string, unknown>;
  return JSON.stringify({
    message: x.message,
    detail: x.detail,
    hint: x.hint,
    where: x.where,
    constraint: x.constraint,
    column: x.column,
    table: x.table,
  });
};
async function failure(promise: Promise<unknown>): Promise<{ code?: string; text: string }> {
  try {
    await promise;
  } catch (e) {
    return { code: (e as { code?: string }).code, text: errorText(e) };
  }
  throw new Error('expected the statement to fail');
}

let master: OrderMaster;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    actors[role] = await realActor(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await orderMaster(app, actors.owner.id, marker);
  await as('owner', (tx) => insertOrder(tx, actors.owner.id, master));
  await as('office', (tx) => insertOrder(tx, actors.office.id, master));
});

describe('functions the application role can execute', () => {
  const ALLOWED = [
    'audit.is_money_table(p_table text)',
    'audit.record(p_action text, p_table text, p_row_id text, p_before jsonb, p_after jsonb, p_reason text)',
    'ctx.request_id()',
    'ctx.role()',
    'ctx.sim_at()',
    'ctx.sim_now()',
    'ctx.user_id()',
    'public.allocate_to_order(p_instrument uuid, p_order_code text)',
    'public.allocate_to_purchase(p_instrument uuid, p_purchase_code text)',
    'public.default_cash_account()',
    'public.delivery_note(p_delivery uuid)',
    'public.invoice_source(p_order_code text)',
    'public.ledger_parameter(p_key text)',
    'public.next_code(p_key text, p_width integer)',
    'public.ops_parameter(p_key text)',
    'public.next_doc_number(p_prefix text, p_year integer, p_width integer)',
    'public.record_receipt(p_purchase uuid, p_date date)',
    'public.resolve_selling_price(p_type uuid, p_client uuid, p_date date)',
  ];

  it('is exactly the reviewed list (a new function must be reviewed for exposure and added here)', async () => {
    const { rows } = await migrator.query<{ f: string }>(
      `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'ctx', 'audit') and p.prokind = 'f'
          and has_function_privilege('belgobeton_app', p.oid, 'EXECUTE')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        order by 1`,
    );
    expect(rows.map((r) => r.f)).toEqual([...ALLOWED].sort());
  });

  it('every SECURITY DEFINER function pins its search_path', async () => {
    const { rows } = await migrator.query<{ f: string }>(
      `select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'ctx', 'audit') and p.prosecdef
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(rows).toEqual([]);
  });

  it('resolve_selling_price refuses partner, plant, support and anonymous, with a message that holds no amount', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      const f = await failure(
        as(role, (tx) =>
          tx.query('select * from public.resolve_selling_price($1, $2, $3)', [
            master.typeId,
            master.clientId,
            '2026-06-01',
          ]),
        ),
      );
      expect(f.code, role).toBe('42501');
      expect(leaks(f.text), role).toBe(false);
    }
    const anon = await failure(
      inCtx('anonymous', '00000000-0000-7000-8000-000000000000', (tx) =>
        tx.query('select * from public.resolve_selling_price($1, $2, $3)', [
          master.typeId,
          master.clientId,
          '2026-06-01',
        ]),
      ),
    );
    expect(anon.code).toBe('42501');
  });

  it('resolve_selling_price is the one deliberate door: office gets the unit price of a type for a client (decision A, server-side price), nothing else', async () => {
    const { rows, fields } = await as('office', (tx) =>
      tx.query('select * from public.resolve_selling_price($1, $2, $3)', [
        master.typeId,
        master.clientId,
        '2026-06-01',
      ]),
    );
    expect(fields.map((f) => f.name)).toEqual(['id', 'price_ht_per_m3_centimes']);
    expect(rows).toHaveLength(1);
  });

  it('ledger_parameter hands the three ledger parameters to office and refuses everyone else and every other key', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      expect(
        (await failure(as(role, (tx) => tx.query(`select public.ledger_parameter('vat_rate_bp')`)))).code,
        role,
      ).toBe('42501');
    }
    expect(
      (
        await failure(
          as('office', (tx) => tx.query(`select public.ledger_parameter('session_idle_minutes')`)),
        )
      ).code,
    ).toBe('42501');
    const { rows } = await as('office', (tx) =>
      tx.query(`select public.ledger_parameter('vat_rate_bp') as v`),
    );
    expect(rows).toHaveLength(1);
  });

  it('next_doc_number numbers documents for owner and office only and returns just a code', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      expect(
        (await failure(as(role, (tx) => tx.query(`select public.next_doc_number('CMD', 2026, 5)`)))).code,
        role,
      ).toBe('42501');
    }
    const { rows } = await as('office', (tx) =>
      tx.query<{ n: string }>(`select public.next_doc_number('CMD', 2026, 5) as n`),
    );
    expect(rows[0]?.n).toMatch(/^CMD-2026-\d{5,}$/);
  });
});

describe('views the application role can read', () => {
  const OPS_COLUMNS = [
    'id',
    'code',
    'concrete_type_id',
    'volume_l',
    'delivery_date',
    'zone_id',
    'site_id',
    'client_code',
    'site_label',
    'reverses_id',
    'is_reversed',
  ];

  it('there are exactly two, sales_order_ops and purchase_line_ops, and both are security barriers', async () => {
    const { rows } = await migrator.query<{ v: string; reloptions: string[] | null }>(
      `select n.nspname || '.' || c.relname as v, c.reloptions
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v', 'm') and n.nspname in ('public', 'ctx', 'audit')
          and has_table_privilege('belgobeton_app', c.oid, 'SELECT')`,
    );
    expect(rows.map((r) => r.v).sort()).toEqual(['public.purchase_line_ops', 'public.sales_order_ops']);
    for (const r of rows) expect(r.reloptions, r.v).toContain('security_barrier=true');
  });

  it('exposes operational columns only: no price, total, VAT, plan or amount column', async () => {
    const { rows, fields } = await as('partner', (tx) =>
      tx.query('select * from public.sales_order_ops limit 1'),
    );
    expect(fields.map((f) => f.name).sort()).toEqual([...OPS_COLUMNS].sort());
    for (const name of OPS_COLUMNS)
      expect(name).not.toMatch(/price|total|amount|centimes|vat|ttc|plan|\bht\b/i);
    expect(rows).toHaveLength(1);
  });

  it('gives partner, plant and support rows with no amount, and office, system and anonymous no row at all (count included)', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      const { rows } = await as(role, (tx) => tx.query('select * from public.sales_order_ops'));
      expect(rows.length, role).toBeGreaterThan(0);
      expect(leaks(rows), role).toBe(false);
    }
    for (const [role, id] of [
      ['office', actors.office.id],
      ['system', '00000000-0000-7000-8000-000000000001'],
      ['anonymous', '00000000-0000-7000-8000-000000000000'],
    ] as const) {
      const { rows } = await inCtx(role, id, (tx) =>
        tx.query<{ n: string }>('select count(*)::text as n from public.sales_order_ops'),
      );
      expect(rows[0]?.n, role).toBe('0');
    }
    const noContext = await app.query<{ n: string }>(
      'select count(*)::text as n from public.sales_order_ops',
    );
    expect(noContext.rows[0]?.n).toBe('0');
  });

  it('cannot be probed for amounts by filtering or ordering on a column it does not expose', async () => {
    for (const role of ['partner', 'plant'] as const) {
      expect(
        (
          await failure(
            as(role, (tx) =>
              tx.query('select 1 from public.sales_order_ops where total_ttc_centimes = 936000'),
            ),
          )
        ).code,
        role,
      ).toBe('42703');
    }
  });

  it('cannot be written', async () => {
    for (const role of ['owner', 'office', 'partner', 'plant', 'support'] as const) {
      expect(
        (
          await failure(
            as(role, (tx) =>
              tx.query(`update public.sales_order_ops set volume_l = 1 where code is not null`),
            ),
          )
        ).code,
        role,
      ).toMatch(/^(42501|55000)$/); // no privilege, or not an updatable view
    }
  });
});

describe('the money tables themselves, for the roles that must not read them', () => {
  const TABLES = ['sales_order', 'payment_plan_item'] as const;

  it.each(['office', 'partner', 'plant'] as const)(
    '%s: no row, no count, no oracle through a filter, no statistics',
    async (role) => {
      for (const table of TABLES) {
        const all = await as(role, (tx) => tx.query(`select * from ${table}`));
        expect(all.rows, table).toEqual([]);
        const count = await as(role, (tx) =>
          tx.query<{ n: string }>(`select count(*)::text as n from ${table}`),
        );
        expect(count.rows[0]?.n, table).toBe('0');
        const oracle = await as(role, (tx) =>
          tx.query(
            table === 'sales_order'
              ? `select 1 from sales_order where total_ttc_centimes = 936000`
              : `select 1 from payment_plan_item where amount_centimes = 936000`,
          ),
        );
        expect(oracle.rows, table).toEqual([]);
        const sum = await as(role, (tx) =>
          tx.query<{ s: string | null }>(
            table === 'sales_order'
              ? `select sum(total_ttc_centimes)::text as s from sales_order`
              : `select sum(amount_centimes)::text as s from payment_plan_item`,
          ),
        );
        expect(sum.rows[0]?.s, table).toBeNull();
      }
      const stats = await as(role, (tx) =>
        tx.query(
          `select * from pg_stats where schemaname = 'public' and tablename in ('sales_order', 'payment_plan_item', 'selling_price', 'purchase_price', 'correction_request')`,
        ),
      );
      expect(stats.rows).toEqual([]);
      const ext = await as(role, (tx) => tx.query(`select * from pg_stats_ext where schemaname = 'public'`));
      expect(ext.rows).toEqual([]);
    },
  );

  it('office: RETURNING (even through a CTE) is refused and says nothing about the amounts', async () => {
    const insertSql = (
      suffix: string,
    ) => `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date,
        selling_price_id, unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
      values (gen_random_uuid(), 'X-${marker.slice(5, 12)}${suffix}', '${master.clientId}', '${master.typeId}', 10000, '2026-06-01', '2026-06-02',
        '${master.sellingPriceId}', 78000, 2000, 780000, 156000, 936000, '${actors.office.id}')`;
    for (const q of [
      `${insertSql('a')} returning total_ttc_centimes`,
      `${insertSql('b')} returning *`,
      `with ins as (${insertSql('c')} returning *) select * from ins`,
    ]) {
      const f = await failure(as('office', (tx) => tx.query(q)));
      expect(f.code, q).toBe('42501');
      expect(leaks(f.text), q).toBe(false);
    }
  });

  it('office: a rejected insert (plan that does not add up, wrong price, duplicate code) reports no amount', async () => {
    // plan item of 1,00 against a total of 9 360,00: the deferred balance trigger fires on commit
    const unbalanced = await failure(
      as('office', async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                                    unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values ($1, $2, $3, $4, 10000, '2026-06-01', '2026-06-02', $5, 78000, 2000, 780000, 156000, 936000, $6)`,
          [
            id,
            `U-${marker.slice(5, 14)}`,
            master.clientId,
            master.typeId,
            master.sellingPriceId,
            actors.office.id,
          ],
        );
        await tx.query(
          `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
           values (gen_random_uuid(), $1, 1, 'in', 'cash', '2026-06-02', 100, $2)`,
          [id, actors.office.id],
        );
      }),
    );
    expect(unbalanced.code).toBe('23514');
    expect(leaks(unbalanced.text)).toBe(false);
    expect(unbalanced.text).not.toMatch(/adds up to \d/);

    const wrongPrice = await failure(
      as('office', (tx) =>
        tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                                    unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), $1, $2, $3, 10000, '2026-06-01', '2026-06-02', $4, 1, 2000, 10, 2, 12, $5)`,
          [
            `P-${marker.slice(5, 14)}`,
            master.clientId,
            master.typeId,
            master.sellingPriceId,
            actors.office.id,
          ],
        ),
      ),
    );
    expect(wrongPrice.code).toBe('23514');
    expect(leaks(wrongPrice.text)).toBe(false);
    expect(wrongPrice.text).not.toMatch(/78000/);

    const existing = await migrator.query<{ code: string }>(`select code from sales_order limit 1`);
    const duplicate = await failure(
      as('office', (tx) =>
        tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                                    unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), $1, $2, $3, 10000, '2026-06-01', '2026-06-02', $4, 78000, 2000, 780000, 156000, 936000, $5)`,
          [existing.rows[0]?.code, master.clientId, master.typeId, master.sellingPriceId, actors.office.id],
        ),
      ),
    );
    expect(duplicate.code).toBe('23505');
    expect(duplicate.text).not.toMatch(/ht_centimes|ttc|936000|780000|156000/);
  });

  it('office: the correction request answers the same for an unknown and an existing code, and shows no amount', async () => {
    const known = await migrator.query<{ code: string }>(`select code from sales_order limit 1`);
    const answers = [];
    for (const code of [known.rows[0]?.code, 'CMD-1999-99999']) {
      answers.push(
        await as('office', (tx) =>
          tx.query(
            `insert into correction_request (id, document_code, reason, requested_by) values (gen_random_uuid(), $1, 'test', $2)`,
            [code, actors.office.id],
          ),
        ).then((r) => ({ ok: true, command: r.command, rowCount: r.rowCount })),
      );
    }
    expect(answers[0]).toEqual(answers[1]);
  });
});

describe('security alerts (break-glass), DECISIONS 75 and 81', () => {
  it('the stored text is a fixed sentence: no amount, balance, client or supplier', () => {
    expect(OWNER_2FA_RESET_DETAIL).not.toMatch(
      /\d{3,}|MAD|DH|centime|solde|balance|montant|amount|client|fournisseur|supplier/i,
    );
  });

  it('the alert kind is closed by the database (a free-form alert cannot be inserted by the application role)', async () => {
    const { rows } = await migrator.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.security_alert'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'`,
    );
    expect(rows[0]?.def).toMatch(/owner_2fa_reset/);
    const f = await failure(
      as('office', (tx) =>
        tx.query(`insert into security_alert (kind, at, detail) values ('owner_2fa_reset', now(), 'x')`),
      ),
    );
    expect(f.code).toBe('42501');
  });

  it('owner, partner and support can read the alerts; office and plant cannot', async () => {
    await withRlsContext(
      systemPool,
      { userId: '00000000-0000-7000-8000-000000000001', role: 'system', requestId: marker },
      (tx) =>
        tx.query(`insert into security_alert (kind, at, detail) values ('owner_2fa_reset', now(), $1)`, [
          OWNER_2FA_RESET_DETAIL,
        ]),
    );
    for (const role of ['owner', 'partner', 'support'] as const) {
      const { rows } = await as(role, (tx) =>
        tx.query<{ detail: string }>('select detail from security_alert'),
      );
      expect(rows.length, role).toBeGreaterThan(0);
      expect(
        rows.some((r) => r.detail === OWNER_2FA_RESET_DETAIL),
        role,
      ).toBe(true);
    }
    for (const role of ['office', 'plant'] as const) {
      const { rows } = await as(role, (tx) => tx.query('select 1 from security_alert'));
      expect(rows, role).toEqual([]);
    }
  });

  it('every alert row stored so far holds the fixed sentence only', async () => {
    const { rows } = await as('owner', (tx) =>
      tx.query<{ detail: string | null }>("select detail from security_alert where detail like 'Owner 2FA%'"),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.detail).toBe(OWNER_2FA_RESET_DETAIL);
  });
});
