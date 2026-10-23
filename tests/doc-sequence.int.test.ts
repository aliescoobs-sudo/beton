import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { formatDocNumber } from '../src/modules/ledger/domain/doc-number';
import { testEnv } from './db-env';
import { realActor, type TestActor } from './helpers/actors';

// ledger L2, AC-LED-08 (counter part): gapless yearly numbers under concurrency and rollback; nobody but the function
// writes the table; office numbers documents without reading the counters (DECISIONS 81).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 12 });
afterAll(() => app.end());

const actors = {} as Record<'owner' | 'office' | 'partner' | 'plant' | 'support', TestActor>;
beforeAll(async () => {
  for (const role of ['owner', 'office', 'partner', 'plant', 'support'] as const) {
    actors[role] = await realActor(env.DATABASE_URL_MIGRATOR, role);
  }
});
const as = <T>(role: keyof typeof actors, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: actors[role].id, role, requestId: 'doc-seq' }, fn);
/** A fresh prefix per test (letters only), so runs never share a counter. */
const prefix = () => Array.from(randomBytes(4), (b) => String.fromCharCode(65 + (b % 26))).join('');
const next = (tx: pg.PoolClient, p: string, year = 2026, width = 5) =>
  tx
    .query<{ n: string }>('select public.next_doc_number($1, $2, $3) as n', [p, year, width])
    .then((r) => r.rows[0]?.n);

describe('next_doc_number', () => {
  it('10 parallel calls give 10 consecutive numbers', async () => {
    const p = prefix();
    const numbers = await Promise.all(Array.from({ length: 10 }, () => as('office', (tx) => next(tx, p))));
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `${p}-2026-${String(i + 1).padStart(5, '0')}`),
    );
  });

  it('stays gapless after a rollback: the number comes back', async () => {
    const p = prefix();
    expect(await as('owner', (tx) => next(tx, p))).toBe(`${p}-2026-00001`);
    await expect(
      as('owner', async (tx) => {
        expect(await next(tx, p)).toBe(`${p}-2026-00002`);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await as('owner', (tx) => next(tx, p))).toBe(`${p}-2026-00002`);
  });

  it('a new year restarts at 1, and years count independently', async () => {
    const p = prefix();
    await as('owner', (tx) => next(tx, p, 2026));
    await as('owner', (tx) => next(tx, p, 2026));
    expect(await as('owner', (tx) => next(tx, p, 2027))).toBe(`${p}-2027-00001`);
    expect(await as('owner', (tx) => next(tx, p, 2026))).toBe(`${p}-2026-00003`);
  });

  it('agrees with the domain formatter, and never truncates a wider number', async () => {
    expect(await as('owner', (tx) => next(tx, 'CMD', 2098))).toBe(formatDocNumber('CMD', 2098, 1));
    const p = prefix();
    expect(await as('owner', (tx) => next(tx, p, 2026, 1))).toBe(`${p}-2026-1`);
    for (let i = 0; i < 9; i++) await as('owner', (tx) => next(tx, p, 2026, 1));
    expect(await as('owner', (tx) => next(tx, p, 2026, 1))).toBe(`${p}-2026-11`);
  });

  it('is refused for partner, plant and support, and outside a request context', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      await expect(
        as(role, (tx) => next(tx, prefix())),
        role,
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(app.query(`select public.next_doc_number('ZZZ', 2026, 5)`)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses a malformed prefix or year (CHECK)', async () => {
    await expect(as('owner', (tx) => next(tx, 'cmd'))).rejects.toMatchObject({ code: '23514' });
    await expect(as('owner', (tx) => next(tx, 'CMD', 1999))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('doc_sequence table access', () => {
  it('office and the others cannot write it directly; the app role has no write privilege at all', async () => {
    for (const role of ['owner', 'office', 'partner', 'plant', 'support'] as const) {
      for (const sql of [
        `insert into doc_sequence (prefix, year, last_value) values ('HAK', 2026, 99)`,
        `update doc_sequence set last_value = 1`,
        `delete from doc_sequence`,
      ]) {
        await expect(
          as(role, (tx) => tx.query(sql)),
          `${role}: ${sql}`,
        ).rejects.toMatchObject({ code: '42501' });
      }
    }
  });

  it('office numbers a document without reading any counter; owner and support read them', async () => {
    const p = prefix();
    await as('office', (tx) => next(tx, p));
    const rows = (role: keyof typeof actors) =>
      as(role, (tx) => tx.query(`select 1 from doc_sequence where prefix = $1`, [p])).then(
        (r) => r.rows.length,
      );
    expect(await rows('office')).toBe(0);
    expect(await rows('partner')).toBe(0);
    expect(await rows('plant')).toBe(0);
    expect(await rows('owner')).toBe(1);
    expect(await rows('support')).toBe(1);
  });

  it('every number is audited', async () => {
    const p = prefix();
    await as('office', (tx) => next(tx, p));
    const { rows } = await as('owner', (tx) =>
      tx.query(`select action from audit_event where table_name = 'doc_sequence' and after->>'prefix' = $1`, [
        p,
      ]),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
