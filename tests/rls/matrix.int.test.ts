import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_ROLES, withRlsContext } from '../../src/lib/db/rls-context';
import { RLS_TABLES, TABLE_ACCESS } from '../../src/modules/platform-security/domain/table-access';
import { testEnv } from '../db-env';

// AC-SEC-04, generated from the registry: for every RLS table × every role, read exactly what the matrix allows.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const marker = `matrix-${randomUUID()}`;
// One actor per role; each writes rows tagged with the run marker.
const actors = Object.fromEntries(DB_ROLES.map((role) => [role, randomUUID()])) as Record<
  (typeof DB_ROLES)[number],
  string
>;

/** Per-table seeding: rows owned by each actor, tagged with `marker`. */
const SEED: Record<(typeof RLS_TABLES)[number], (tx: pg.PoolClient) => Promise<void>> = {
  audit_event: (tx) =>
    tx.query(`select audit.record('export', 'matrix', null, null, null, $1)`, [marker]).then(() => undefined),
};
const VISIBLE: Record<(typeof RLS_TABLES)[number], string> = {
  audit_event: `select actor_user_id::text as owner from audit_event where reason = $1`,
};

beforeAll(async () => {
  for (const table of RLS_TABLES) {
    for (const role of DB_ROLES) {
      await withRlsContext(app, { userId: actors[role], role, requestId: marker }, SEED[table]);
    }
  }
});

describe.each(RLS_TABLES)('RLS on %s', (table) => {
  const rule = TABLE_ACCESS[table];

  it.each(DB_ROLES)('role %s sees exactly what the matrix allows', async (role) => {
    const { rows } = await withRlsContext(app, { userId: actors[role], role, requestId: marker }, (tx) =>
      tx.query<{ owner: string }>(VISIBLE[table], [marker]),
    );
    const seen = rows.map((r) => r.owner).sort();
    const scope = rule.read[role];
    const expected = scope === 'all' ? Object.values(actors).sort() : scope === 'own' ? [actors[role]] : [];
    expect(seen).toEqual(expected);
  });

  it('nothing is visible outside a request context', async () => {
    const { rows } = await app.query(VISIBLE[table], [marker]);
    expect(rows).toEqual([]);
  });
});
