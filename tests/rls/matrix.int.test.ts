import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_ROLES, withRlsContext } from '../../src/lib/db/rls-context';
import { RLS_TABLES, TABLE_ACCESS } from '../../src/modules/platform-security/domain/table-access';
import { testEnv } from '../db-env';
import { realActor } from '../helpers/actors';
import { resetSimClock } from '../helpers/reset-sim-clock';
import { ANONYMOUS_ACTOR_ID, SYSTEM_ACTOR_ID } from '../../src/modules/platform-security/auth/actors';
import { USER_ROLES } from '../../src/modules/platform-security/domain/permissions';

// AC-SEC-04, generated from the registry: for every RLS table × every role, read exactly what the matrix allows.
type DbRole = (typeof DB_ROLES)[number];
type RlsTable = (typeof RLS_TABLES)[number];

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(async () => {
  await resetSimClock();
  await Promise.all([app.end(), system.end()]);
});

const marker = `matrix_${randomUUID().replace(/-/g, '')}`;
// One actor per role: real accounts for user roles, the fixed actors otherwise (the database checks roles, DECISIONS 76).
const actors = {} as Record<DbRole, string>;

/**
 * Per table: which roles can write seed rows, how to write one for an actor, and a query returning the actor
 * (`owner` column) of each visible seeded row.
 */
const FIXTURES: Record<
  RlsTable,
  {
    writers: readonly DbRole[];
    /** Database role that writes the seed rows (default belgobeton_app). */
    pool?: 'system';
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
  security_checklist_item: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into security_checklist_item (key, status, evidence, checked_by, checked_at) values ($1, 'done', 'x', $2, now())`,
        [`test_${marker}`, actor],
      ),
    visible: `select checked_by::text as owner from security_checklist_item where key = 'test_' || $1`,
  },
  security_check_run: {
    // Failed runs: they must not count as a recent successful restore test for other suites.
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(
        `insert into security_check_run (key, ok, at, detail) values ('restore_test', false, now(), $1)`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(detail, ':', 2) as owner from security_check_run where detail like $1 || ':%'`,
  },
  security_alert: {
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(`insert into security_alert (kind, at, detail) values ('owner_2fa_reset', now(), $1)`, [
        `${marker}:${actor}`,
      ]),
    visible: `select split_part(detail, ':', 2) as owner from security_alert where detail like $1 || ':%'`,
  },
  sim_clock: {
    // Singleton: seeded in 'real' mode so other suites never see a simulated instant.
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(
        `insert into sim_clock (mode, sim_now, updated_by, updated_at) values ('real', now(), $1, now())
         on conflict do nothing`,
        [actor],
      ),
    visible: `select updated_by::text as owner from sim_clock where $1::text is not null`,
  },
  scheduled_job_run: {
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(
        `insert into scheduled_job_run (id, job_key, business_date, status, ran_at, run_by)
         values (gen_random_uuid(), $1, '2000-01-01', 'succeeded', now(), $2)`,
        [`matrix-${marker.slice(-12)}`, actor],
      ),
    visible: `select run_by::text as owner from scheduled_job_run where job_key = 'matrix-' || right($1, 12)`,
  },
  zone: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 10)`, [
        `${marker}:${actor}`,
      ]),
    visible: `select split_part(name, ':', 2) as owner from zone where name like $1 || ':%'`,
  },
  code_sequence: {
    // One counter per writer role, keyed by the role so the visible query can name its actor. Persistent by design.
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) => {
      const role = Object.entries(actors).find(([, id]) => id === actor)![0];
      return tx.query(
        `insert into code_sequence (key, last_value) values ($1, 0) on conflict (key) do nothing`,
        [{ owner: 'MXO', partner: 'MXP', office: 'MXF' }[role as 'owner' | 'partner' | 'office']],
      );
    },
    get visible() {
      return `select case key when 'MXO' then '${actors.owner}' when 'MXP' then '${actors.partner}'
                               when 'MXF' then '${actors.office}' end as owner
                from code_sequence where key like 'MX_' and $1::text is not null`;
    },
  },
  client: {
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) =>
      tx.query(
        `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person')`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(name, ':', 2) as owner from client where name like $1 || ':%'`,
  },
  client_site: {
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) =>
      tx.query(
        `insert into client_site (id, client_id, label)
         select gen_random_uuid(), id, $2 from client where name like $1 || ':%' limit 1`,
        [marker, `site:${marker}:${actor}`],
      ),
    visible: `select split_part(label, ':', 3) as owner from client_site where label like 'site:' || $1 || ':%'`,
  },
  supplier: {
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) =>
      tx.query(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'other')`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(name, ':', 2) as owner from supplier where name like $1 || ':%'`,
  },
  security_alert_ack: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into security_alert_ack (alert_id, user_id, at)
         select id, $2, now() from security_alert where detail like $1 || ':%'`,
        [marker, actor],
      ),
    visible: `select k.user_id::text as owner from security_alert_ack k join security_alert a on a.id = k.alert_id
               where a.detail like $1 || ':%'`,
  },
};

beforeAll(async () => {
  for (const role of USER_ROLES) actors[role] = (await realActor(env.DATABASE_URL_MIGRATOR, role)).id;
  actors.system = SYSTEM_ACTOR_ID;
  actors.anonymous = ANONYMOUS_ACTOR_ID;
  for (const table of RLS_TABLES) {
    for (const role of FIXTURES[table].writers) {
      const pool = FIXTURES[table].pool === 'system' ? system : app;
      await withRlsContext(pool, { userId: actors[role], role, requestId: marker }, (tx) =>
        FIXTURES[table].seed(tx, actors[role]),
      );
    }
  }
});

describe.each(RLS_TABLES)('RLS on %s', (table) => {
  const rule = TABLE_ACCESS[table];

  it.each(DB_ROLES)('role %s sees exactly what the matrix allows', async (role) => {
    const { rows } = await withRlsContext(app, { userId: actors[role], role, requestId: marker }, (tx) =>
      tx.query<{ owner: string }>(FIXTURES[table].visible, [marker]),
    );
    const seededBy = FIXTURES[table].writers.map((r) => actors[r]);
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
