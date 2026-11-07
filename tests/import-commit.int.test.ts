import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportEnvironment, ImportTransactionError, type SheetMapping } from '../src/modules/importer';
import { importWorkbook, rollbackImport } from './helpers/import-proof';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { buildWorkbook } from './helpers/xlsx-writer';

// R14-03: the end of the import transaction is told truthfully. The real pool is wrapped so that ONE statement (the COMMIT, or the
// ROLLBACK) can be made to fail the way a database or a network fails; everything else goes to the real database. Synthetic data only.
const env = testEnv();
const real = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([real.end(), migrator.end()]));
const PROD: ImportEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
let stepped: SessionUser;
beforeAll(async () => {
  stepped = {
    ...(await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner')),
    stepUpVerified: true,
  } as SessionUser;
});
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const mapping: SheetMapping = {
  version: 1,
  sheet: 'Clients',
  kind: 'clients',
  headerRow: 1,
  dateFormat: 'dmy',
  columns: {},
};
const fakeIce = () => String(Math.floor(Math.random() * 9e14) + 1e14);
const workbook = (name: string) =>
  buildWorkbook([
    {
      name: 'Clients',
      rows: [
        ['Nom', 'Type', 'ICE', 'Téléphone'],
        [name, 'company', fakeIce(), '0600000000'],
      ],
    },
  ]);

interface Spy {
  released: (boolean | undefined)[];
  pool: pg.Pool;
}
/** A pool whose connections answer `fail` for the statement `on`, instead of the database. */
function failing(on: 'COMMIT' | 'ROLLBACK', fail: () => Promise<pg.QueryResult> | pg.QueryResult): Spy {
  const released: (boolean | undefined)[] = [];
  const pool = {
    query: real.query.bind(real),
    connect: async () => {
      const c = await real.connect();
      return new Proxy(c, {
        get(t, p) {
          if (p === 'query')
            return (text: unknown, values?: unknown[]) =>
              typeof text === 'string' && text.trim() === on
                ? Promise.resolve(fail()).then(async (r) => {
                    // the real transaction is still open on this connection: close it for real so the test leaves nothing behind
                    await t.query('ROLLBACK').catch(() => undefined);
                    return r;
                  })
                : t.query(text as string, values);
          if (p === 'release')
            return (destroy?: boolean) => {
              released.push(destroy);
              t.release(destroy);
            };
          const v = Reflect.get(t, p) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    },
  } as unknown as pg.Pool;
  return { released, pool };
}
const apply = (pool: pg.Pool, name: string, mode: 'apply' | 'dry-run' = 'apply') =>
  importWorkbook({
    appPool: pool,
    actor: stepped,
    file: workbook(name),
    mappings: [mapping],
    mode,
    environment: PROD,
    requireEveryMappedSheet: false,
  });
const rowsOf = async (name: string) =>
  (await migrator.query('select 1 from client where name = $1', [name])).rowCount;

describe('the import says "applied" only after the database confirmed the commit (R14-03)', () => {
  it('a normal apply commits, reports applied, and gives the connection back to the pool', async () => {
    const name = `Client Fictif ${tag}A`;
    const r = await apply(real, name);
    expect(r.applied).toBe(true);
    expect(await rowsOf(name)).toBe(1);
  });

  it('a commit the SERVER refuses (an SQLSTATE error): COMMIT_FAILED, nothing written, connection destroyed, never "applied"', async () => {
    const name = `Client Fictif ${tag}B`;
    const spy = failing('COMMIT', () => {
      throw Object.assign(new Error('deferred constraint violated: Client Fictif secret row'), {
        code: '23505',
      });
    });
    const err = await apply(spy.pool, name).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImportTransactionError);
    expect((err as ImportTransactionError).code).toBe('COMMIT_FAILED');
    expect((err as Error).message).not.toContain('secret row'); // the database's text is never copied
    expect(spy.released.at(-1)).toBe(true); // destroyed, not returned to the pool
    expect(await rowsOf(name)).toBe(0);
  });

  it('PostgreSQL turns the COMMIT of an aborted transaction into a ROLLBACK without an error: that is COMMIT_FAILED too', async () => {
    const name = `Client Fictif ${tag}C`;
    const spy = failing('COMMIT', () => ({ command: 'ROLLBACK' }) as pg.QueryResult);
    const err = await apply(spy.pool, name).catch((e: unknown) => e);
    expect((err as ImportTransactionError).code).toBe('COMMIT_FAILED');
    expect(await rowsOf(name)).toBe(0);
  });

  it('a connection lost during the commit: COMMIT_OUTCOME_UNKNOWN (not "failed", not "done"), connection destroyed', async () => {
    const name = `Client Fictif ${tag}D`;
    const spy = failing('COMMIT', () => {
      throw new Error('Connection terminated unexpectedly'); // no SQLSTATE: the server never answered
    });
    const err = await apply(spy.pool, name).catch((e: unknown) => e);
    expect((err as ImportTransactionError).code).toBe('COMMIT_OUTCOME_UNKNOWN');
    expect((err as Error).message).toMatch(/NOT known/);
    expect(spy.released.at(-1)).toBe(true);
  });

  it('a dry run whose ROLLBACK cannot be confirmed fails with ROLLBACK_FAILED instead of claiming "nothing was written"', async () => {
    const spy = failing('ROLLBACK', () => {
      throw new Error('Connection terminated unexpectedly');
    });
    const err = await apply(spy.pool, `Client Fictif ${tag}E`, 'dry-run').catch((e: unknown) => e);
    expect((err as ImportTransactionError).code).toBe('ROLLBACK_FAILED');
    expect(spy.released.at(-1)).toBe(true);
  });

  it('a soft rollback whose commit fails is reported as failed, not as completed', async () => {
    const name = `Client Fictif ${tag}F`;
    const done = await apply(real, name);
    expect(done.applied).toBe(true);
    const spy = failing('COMMIT', () => {
      throw Object.assign(new Error('x'), { code: '40001' });
    });
    const err = await rollbackImport({
      appPool: spy.pool,
      actor: stepped,
      runId: done.runId!,
      environment: PROD,
    }).catch((e: unknown) => e);
    expect((err as ImportTransactionError).code).toBe('COMMIT_FAILED');
    expect(spy.released.at(-1)).toBe(true);
    // and the client is still active: the failed rollback changed nothing
    expect((await migrator.query(`select status from client where name = $1`, [name])).rows[0]?.status).toBe(
      'active',
    );
  });
});
