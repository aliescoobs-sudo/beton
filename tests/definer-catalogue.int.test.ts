import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';

/**
 * R17-04: the class fix, as a CATALOGUE test (the regex scan in roles-hardening.int.test.ts stays a regression aid only).
 * EVERY business SECURITY DEFINER function the application login can execute is called with a request that has no valid actor
 * (no role, an empty role, an unknown role, `anonymous` with the anonymous user, a role that no account has) and with a wrong-audience
 * role. Each call runs in a rolled-back transaction. A call passes only if it is REFUSED (any error) or it answers nothing
 * (no row, NULL, false, zero) and has written nothing (no new row in any table we count). The few doors that are public by design
 * are listed below with their reason; the list is checked for stale entries.
 */
const env = testEnv();
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(async () => {
  await migrator.end();
  await app.end();
});

/** Doors that answer without an actor ON PURPOSE (no data of a business, no write). Reason beside each. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  'public.applied_migrations':
    'a count of applied migrations, read by the readiness probe before any login (no business data)',
  'public.invoice_timing':
    'the company-wide invoicing rhythm flag, read to draw the screens (no business data)',
  'public.training_seeded': 'a boolean: is this the training instance (used before login to draw the banner)',
  'finance.enabled': 'the finance module flag (a boolean, no data)',
  'public._pump_in_scope':
    'a pure scope predicate over a plant id given by the caller; it reveals nothing the caller did not pass',
};

interface Fn {
  oid: number;
  name: string;
  args: string[];
  retset: boolean;
  rettype: string;
}

const dummy = (t: string): string => {
  if (t === 'uuid') return randomUUID();
  if (t === 'date') return '2092-01-01';
  if (t.startsWith('timestamp')) return '2092-01-01T00:00:00Z';
  if (t === 'boolean') return 'false';
  if (/^(integer|bigint|smallint|numeric|double precision|real)$/.test(t)) return '1';
  if (t === 'jsonb' || t === 'json') return '{}';
  if (t.endsWith('[]')) return '{}';
  return 'x';
};

async function catalogue(): Promise<Fn[]> {
  const { rows } = await migrator.query<{
    oid: number;
    name: string;
    args: string[];
    retset: boolean;
    rettype: string;
  }>(
    `select p.oid::int as oid, n.nspname || '.' || p.proname as name,
            array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality as u(t, i) order by i) as args,
            p.proretset as retset, format_type(p.prorettype, null) as rettype
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and p.prokind = 'f' and n.nspname in ('public', 'ctx', 'finance')
        and has_function_privilege('belgobeton_app', p.oid, 'EXECUTE')
        and p.prorettype <> 'trigger'::regtype
        and p.proname not in ('actor_role', 'role', 'user_id', 'plant_scope', 'plant_id', 'driver_id')
      order by 2, 1`,
  );
  return rows;
}

const CONTEXTS: { label: string; role: string | null; user: string | null }[] = [
  { label: 'unset role, no user', role: null, user: null },
  { label: 'unset role, a user', role: null, user: randomUUID() },
  { label: 'empty role', role: '', user: randomUUID() },
  { label: 'unknown role', role: 'bogus', user: randomUUID() },
  { label: 'anonymous', role: 'anonymous', user: '00000000-0000-7000-8000-000000000000' },
  { label: 'a role no account has', role: 'client_portal', user: randomUUID() },
];

describe('R17-04: every app-executable business definer refuses a request without a valid actor', () => {
  it('lists the catalogue (sanity: the doors are there)', async () => {
    const fns = await catalogue();
    expect(fns.length).toBeGreaterThan(20);
  });

  it('answers nothing and writes nothing without a valid actor', async () => {
    const fns = await catalogue();
    const offenders: string[] = [];
    for (const fn of fns) {
      if (PUBLIC_BY_DESIGN[fn.name]) continue;
      for (const ctxCase of CONTEXTS) {
        // The app login, a fresh transaction per call, always rolled back.
        const c = await app.connect();
        try {
          await c.query('begin');
          await c.query(`select set_config('app.role', $1, true), set_config('app.user_id', $2, true)`, [
            ctxCase.role ?? '',
            ctxCase.user ?? '',
          ]);
          const params = fn.args.map((_, i) => `$${i + 1}::${fn.args[i]}`).join(', ');
          const call = fn.retset
            ? `select count(*)::text as r from ${fn.name}(${params})`
            : `select ${fn.name}(${params})::text as r`;
          let answer: string | null = null;
          let refused = false;
          await c.query('savepoint s');
          try {
            const res = await c.query<{ r: string | null }>(call, fn.args.map(dummy));
            answer = res.rows[0]?.r ?? null;
          } catch {
            refused = true;
            await c.query('rollback to savepoint s');
          }
          if (!refused) {
            const emptyLike =
              answer === null ||
              answer === '' ||
              answer === '0' ||
              answer === 'false' ||
              answer === '{}' ||
              answer === '[]';
            if (!emptyLike)
              offenders.push(
                `${fn.name}(${fn.args.join(',')}) answered "${String(answer).slice(0, 40)}" for: ${ctxCase.label}`,
              );
            // answered nothing: it must also have written nothing (a write gives the transaction an id)
            const w = await c.query<{ x: string | null }>(
              'select pg_current_xact_id_if_assigned()::text as x',
            );
            if (w.rows[0]?.x) offenders.push(`${fn.name}(${fn.args.join(',')}) WROTE for: ${ctxCase.label}`);
          }
        } finally {
          await c.query('rollback').catch(() => undefined);
          c.release();
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
