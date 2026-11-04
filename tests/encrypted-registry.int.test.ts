import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createTruck, fieldCipherFrom } from '../src/modules/master-data';
import { ENCRYPTED_COLUMNS } from '../src/modules/platform-security/domain/encrypted-columns';
import { countOnOldKeys, rotateColumn } from '../src/modules/platform-security/service/key-rotation';
import { keyringCipher } from '../src/modules/platform-security/service/key-rotation';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// D6 / F06 (CODEX-REVIEW-FINAL): the key-rotation registry lists every sealed column of the schema. A new `*_enc` column that nobody
// registers fails here, because `crypto-rotate` would otherwise report success while that column stays on a retired key.
const env = testEnv();
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(() => Promise.all([migrator.end(), app.end(), system.end()]));

describe('the registry is complete (F06)', () => {
  it('every *_enc column of the database is registered, and every registered column exists', async () => {
    const { rows } = await migrator.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and column_name like '%\\_enc' order by 1, 2`,
    );
    const found = rows.map((r) => `${r.table_name}.${r.column_name}`);
    const registered = ENCRYPTED_COLUMNS.filter((c) => c.column.endsWith('_enc')).map(
      (c) => `${c.table}.${c.column}`,
    );
    expect(
      found.filter((c) => !registered.includes(c)),
      'sealed columns missing from ENCRYPTED_COLUMNS',
    ).toEqual([]);
    // the four of the review are there
    for (const c of [
      'supplier.phone_enc',
      'trip_instruction.address_enc',
      'pump_job.address_enc',
      'cancellation_case.redirect_address_enc',
    ])
      expect(registered).toContain(c);
    for (const spec of ENCRYPTED_COLUMNS) {
      const exists = await migrator.query(
        `select 1 from information_schema.columns where table_name = $1 and column_name = $2`,
        [spec.table, spec.column],
      );
      expect(exists.rowCount, `${spec.table}.${spec.column}`).toBe(1);
    }
  });

  it('the system actor can re-seal each registered column of the system pool and nothing else on those tables', async () => {
    for (const spec of ENCRYPTED_COLUMNS.filter((c) => c.pool === 'system')) {
      const priv = await migrator.query<{ read: boolean; write: boolean }>(
        `select has_column_privilege('belgobeton_system', $1, $2, 'SELECT') as read,
                has_column_privilege('belgobeton_system', $1, $2, 'UPDATE') as write`,
        [`public.${spec.table}`, spec.column],
      );
      expect(priv.rows[0], `${spec.table}.${spec.column}`).toEqual({ read: true, write: true });
      // no other column of the table may be updated by the system actor
      const others = await migrator.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name <> $2
            and has_column_privilege('belgobeton_system', $3, column_name, 'UPDATE')`,
        [spec.table, spec.column, `public.${spec.table}`],
      );
      // ai_interaction and ai_proposal have older, wider rules of their own (D-assistant); the rotation columns are what is proved here
      if (!['ai_interaction', 'ai_proposal'].includes(spec.table))
        expect(
          others.rows.map((r) => r.column_name),
          spec.table,
        ).toEqual([]);
    }
  });
});

describe('a pump job address is re-sealed by the rotation like any other (F06)', () => {
  let owner: SessionUser;
  beforeAll(async () => {
    owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  });
  it('moves the sealed address of a pump job to the new key and it still opens with the new keyring alone', async () => {
    // The rotation runs inside a transaction that is rolled back: it touches every pump job of the shared test database, and the
    // other tests must keep reading theirs with the environment's keys.
    const current = env.FIELD_ENCRYPTION_KEYS;
    const k2 = `k2x:${Buffer.alloc(32, 22).toString('base64')}`;
    const old = fieldCipherFrom(parseKeyring(current));
    const marker = randomUUID().slice(0, 8);
    const truck = await createTruck(app, owner, {
      code: `P${100 + Math.floor(Math.random() * 890)}`,
      plate: `PR-${marker}`,
      kind: 'pump',
    });
    if (!truck.ok) throw new Error(truck.error);
    const sealed = old.seal(`12 rue du Chantier ${marker}`);
    const operator = (
      await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
        tx.query<{ id: string }>(
          `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'pump_operator') returning id`,
          [`CH-${6000 + Math.floor(Math.random() * 3000)}`, `Op ${marker}`, owner.id],
        ),
      )
    ).rows[0]!.id;
    const id = await withRlsContext(
      migrator,
      { userId: owner.id, role: 'owner', requestId: marker },
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `insert into pump_job (id, job_date, pump_id, operator_id, site_label, address_enc, created_by)
             values (gen_random_uuid(), '2026-08-01', $1, $2, 'Chantier', $3, $4) returning id`,
            [truck.value.id, operator, sealed, owner.id],
          )
        ).rows[0]!.id,
    );
    const spec = ENCRYPTED_COLUMNS.find((c) => c.table === 'pump_job')!;
    const ring = parseKeyring(`${k2},${current}`);
    await withRlsContext(
      system,
      { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: marker, rollback: true },
      async (tx) => {
        const q = { query: (text: string, values?: unknown[]) => tx.query(text, values) } as unknown as Pick<
          pg.Pool,
          'query'
        >;
        expect(await countOnOldKeys(q, spec, keyringCipher(ring))).toBeGreaterThanOrEqual(1);
        const result = await rotateColumn(q, spec, ring);
        expect(result.remaining).toBe(0);
        const after = await tx.query<{ address_enc: string }>(
          `select address_enc from pump_job where id = $1`,
          [id],
        );
        expect(after.rows[0]!.address_enc.startsWith('f1.k2x.')).toBe(true);
        expect(fieldCipherFrom(parseKeyring(k2)).open(after.rows[0]!.address_enc)).toBe(
          `12 rue du Chantier ${marker}`,
        );
      },
    );
  });
});
