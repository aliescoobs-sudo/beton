import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';

const env = testEnv();
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => migrator.end());

const runtimeRoles = ['belgobeton_app', 'belgobeton_auth', 'belgobeton_system', 'belgobeton_seed'];

async function roleRow(name: string) {
  const { rows } = await migrator.query(
    `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
       from pg_roles where rolname = $1`,
    [name],
  );
  return rows[0];
}

describe('database roles (SPEC-platform-security §4)', () => {
  it.each(runtimeRoles)('%s has no elevated attributes', async (name) => {
    expect(await roleRow(name)).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
  });

  it.each(runtimeRoles)('%s owns no tables, sequences or views', async (name) => {
    const { rows } = await migrator.query(
      `select count(*)::int as owned from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = $1`,
      [name],
    );
    expect(rows[0].owned).toBe(0);
  });

  it.each(runtimeRoles)('%s cannot create objects in the public schema', async (name) => {
    const { rows } = await migrator.query(`select has_schema_privilege($1, 'public', 'CREATE') as can`, [
      name,
    ]);
    expect(rows[0].can).toBe(false);
  });

  it('the backup role bypasses RLS to dump, but cannot write anything', async () => {
    expect(await roleRow('belgobeton_backup')).toMatchObject({
      rolsuper: false,
      rolbypassrls: true,
      rolcreaterole: false,
    });
    const backup = new pg.Client({ connectionString: env.DATABASE_URL_BACKUP });
    await backup.connect();
    try {
      await expect(
        backup.query(
          `insert into parameter (key, value, updated_by, updated_at) values ('x.y', '1', gen_random_uuid(), now())`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(backup.query('create table backup_should_not_create (id int)')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await backup.end();
    }
  });

  it('migrator is not a superuser and cannot bypass RLS', async () => {
    expect(await roleRow('belgobeton_migrator')).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it('the app role can connect but cannot create a table', async () => {
    const app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await app.connect();
    try {
      await expect(app.query('create table app_should_not_create (id int)')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });
});
