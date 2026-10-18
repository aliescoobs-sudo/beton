import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_ROLES, withRlsContext } from '../../src/lib/db/rls-context';
import { RLS_TABLES, TABLE_ACCESS } from '../../src/modules/platform-security/domain/table-access';
import { testEnv } from '../db-env';

// AC-SEC-04, generated from the registry: for every RLS table × every role, read exactly what the matrix allows.
type DbRole = (typeof DB_ROLES)[number];
type RlsTable = (typeof RLS_TABLES)[number];

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const marker = `matrix_${randomUUID().replace(/-/g, '')}`;
// One actor per role.
const actors = Object.fromEntries(DB_ROLES.map((role) => [role, randomUUID()])) as Record<DbRole, string>;

/**
 * Per table: which roles can write seed rows, how to write one for an actor, and a query returning the actor
 * (`owner` column) of each visible seeded row.
 */
const FIXTURES: Record<
  RlsTable,
  {
    writers: readonly DbRole[];
    seed: (tx: pg.PoolClient, actor: string) => Promise<unknown>;
    visible: string;
  }
> = {
  audit_event: {
    writers: DB_ROLES,
    seed: (tx) => tx.query(`select audit.record('export', 'matrix', null, null, null, $1)`, [marker]),
    visible: `select actor_user_id::text as owner from audit_event where reason = $1`,
  },
  parameter: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(`insert into parameter (key, value, updated_by, updated_at) values ($1, '1', $2, now())`, [
        `test.${marker}`,
        actor,
      ]),
    visible: `select updated_by::text as owner from parameter where key = 'test.' || $1`,
  },
};

beforeAll(async () => {
  for (const table of RLS_TABLES) {
    for (const role of FIXTURES[table].writers) {
      await withRlsContext(app, { userId: actors[role], role, requestId: marker }, (tx) =>
        FIXTURES[table].seed(tx, actors[role]),
      );
    }
  }
});

describe.each(RLS_TABLES)('RLS on %s', (table) => {
  const rule = TABLE_ACCESS[table];
  const seededBy = FIXTURES[table].writers.map((r) => actors[r]);

  it.each(DB_ROLES)('role %s sees exactly what the matrix allows', async (role) => {
    const { rows } = await withRlsContext(app, { userId: actors[role], role, requestId: marker }, (tx) =>
      tx.query<{ owner: string }>(FIXTURES[table].visible, [marker]),
    );
    const scope = rule.read[role];
    const expected =
      scope === 'all' ? seededBy : scope === 'own' ? seededBy.filter((a) => a === actors[role]) : [];
    expect(rows.map((r) => r.owner).sort()).toEqual([...expected].sort());
  });

  it('nothing is visible outside a request context', async () => {
    const { rows } = await app.query(FIXTURES[table].visible, [marker]);
    expect(rows).toEqual([]);
  });
});
