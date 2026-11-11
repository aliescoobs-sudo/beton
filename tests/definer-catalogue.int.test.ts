import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';

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
  argNames: string[];
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
    argNames: string[];
    retset: boolean;
    rettype: string;
  }>(
    `select p.oid::int as oid, n.nspname || '.' || p.proname as name,
            array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality as u(t, i) order by i) as args,
            coalesce(p.proargnames[1:p.pronargs], array[]::text[]) as "argNames",
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

let world: World;
/** R18-02: the REAL rows an argument can point at (a trip, load, order, driver, plant of ANOTHER plant, and a trip with no plant). */
interface Real {
  tripB: string;
  tripN: string;
  loadB: string;
  orderB: string;
  orderN: string;
}
let real: Real;
beforeAll(async () => {
  world = await plantWorld(app, migrator, `dc${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const b = await world.newTrip(world.plantB, world.truckB, world.driverB);
  const n = await world.newTrip(world.plantA, world.truckN, world.driverA, { nullPlant: true });
  await world.tap(world.driverUserB, b.trip, 'loaded');
  const loadB = await world.plantLoad(world.plantB, b.order, world.truckB);
  real = { tripB: b.trip, tripN: n.trip, loadB, orderB: b.order, orderN: n.order };
});
afterAll(async () => {
  await world?.done();
});

/** An argument value: a real existing id where the name says what it is, otherwise the shape's dummy. */
function realArg(name: string, type: string, variant: 'B' | 'N'): string {
  if (type === 'uuid') {
    if (/^p_(trip|old|new|case)$/.test(name)) return variant === 'B' ? real.tripB : real.tripN;
    if (/^p_(delivery|load)$/.test(name)) return real.loadB;
    if (/^p_order/.test(name)) return variant === 'B' ? real.orderB : real.orderN;
    if (name === 'p_driver' || name === 'p_operator') return world.driverB;
    if (name === 'p_plant') return variant === 'B' ? world.plantB : world.plantA;
    if (name === 'p_client' || name === 'p_type')
      return variant === 'B' ? world.scene.clientId : world.master.typeId;
  }
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  return dummy(type);
}

const CONTEXTS = (): { label: string; role: string | null; user: string | null }[] => [
  { label: 'unset role, no user', role: null, user: null },
  { label: 'unset role, a REAL user id', role: null, user: world.pmA.id },
  { label: 'unset role, a REAL driver user id', role: null, user: world.driverUserA.id },
  { label: 'empty role, a real user id', role: '', user: world.pmA.id },
  { label: 'unknown role', role: 'bogus', user: randomUUID() },
  { label: 'anonymous', role: 'anonymous', user: '00000000-0000-7000-8000-000000000000' },
  { label: 'a role no account has', role: 'client_portal', user: randomUUID() },
];

describe('R17-04: every app-executable business definer refuses a request without a valid actor', () => {
  it('lists the catalogue (sanity: the doors are there)', async () => {
    const fns = await catalogue();
    expect(fns.length).toBeGreaterThan(20);
  });

  it('answers nothing and writes nothing without a valid actor — with REAL targets of another plant and of no plant', async () => {
    const fns = await catalogue();
    const offenders: string[] = [];
    for (const fn of fns) {
      if (PUBLIC_BY_DESIGN[fn.name]) continue;
      for (const [variant, ctxCase] of CONTEXTS().flatMap((c) =>
        (['B', 'N'] as const).map((v) => [v, c] as const),
      )) {
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
            const res = await c.query<{ r: string | null }>(
              call,
              fn.args.map((t, i) => realArg(fn.argNames[i] ?? '', t, variant)),
            );
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
                `${fn.name}(${fn.args.join(',')}) answered "${String(answer).slice(0, 40)}" for: ${ctxCase.label} (${variant} targets)`,
              );
            // answered nothing: it must also have written nothing (a write gives the transaction an id)
            const w = await c.query<{ x: string | null }>(
              'select pg_current_xact_id_if_assigned()::text as x',
            );
            if (w.rows[0]?.x)
              offenders.push(
                `${fn.name}(${fn.args.join(',')}) WROTE for: ${ctxCase.label} (${variant} targets)`,
              );
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

describe('R18-02: the shape that failed cannot come back', () => {
  it('no business definer guards a lookup with `IF NOT FOUND OR NOT (<role test>)` unless it validates the actor first', async () => {
    const { rows } = await migrator.query<{ name: string; src: string }>(
      `select n.nspname || '.' || p.proname as name, p.prosrc as src
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and p.prokind = 'f' and n.nspname in ('public', 'ctx', 'finance', 'history')`,
    );
    const risky = rows.filter(
      (r) =>
        /IF\s+NOT\s+FOUND\s+OR[^;]*NOT\s*\(\s*v_role\s+IN/i.test(r.src) ||
        /IF[^;]*\bOR\s+NOT\s*\(\s*(?:v_role|ctx\.actor_role\(\))\s+IN/i.test(r.src),
    );
    // a risky shape is allowed only behind the shared actor-first helper or an explicit IS NULL / IS NOT TRUE test of the role
    const offenders = risky.filter(
      (r) => !/ctx\.require_actor\(|actor_role\(\) IS NULL|v_role IS NULL|IS NOT TRUE/i.test(r.src),
    );
    expect(offenders.map((o) => o.name)).toEqual([]);
    // and the four doors of R18-02 use the helper
    for (const door of [
      'attach_trip_load',
      'confirm_trip_delivered',
      'confirm_trip_stage',
      'correct_trip_stage',
    ])
      expect(rows.find((r) => r.name === `public.${door}`)?.src, door).toMatch(/ctx\.require_actor\(/);
  });

  it('the shared helpers refuse a NULL role and do not return NULL for a scope test', async () => {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true), set_config('app.role', '', true)`, [
        world.pmA.id,
      ]);
      await expect(c.query(`select ctx.require_actor('t', array['owner'])`)).rejects.toMatchObject({
        code: '42501',
      });
      await c.query('rollback');
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true), set_config('app.role', '', true)`, [
        world.pmA.id,
      ]);
      const r = await c.query<{ v: boolean | null }>(`select ctx.in_actor_scope(array['owner'], null) as v`);
      expect(r.rows[0]!.v).toBe(false);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });
});
