import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { findTableAccessViolations } from '../../src/modules/platform-security/service/table-access-check';
import { testEnv } from '../db-env';

const migrator = new pg.Pool({ connectionString: testEnv().DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => migrator.end());

describe('every table is registered with its access rule (T14 meta-test)', () => {
  it('finds no violation in the migrated schema', async () => {
    expect(await findTableAccessViolations(migrator)).toEqual([]);
  });

  it('flags a new table that has no registry entry, no RLS and no audit trigger', async () => {
    await migrator.query('create table public.unregistered_probe (id int primary key)');
    try {
      const violations = await findTableAccessViolations(migrator);
      expect(violations).toContainEqual(
        expect.objectContaining({ table: 'unregistered_probe', problem: 'not_registered' }),
      );
    } finally {
      await migrator.query('drop table public.unregistered_probe');
    }
  });

  it('flags a registered RLS table whose RLS was switched off', async () => {
    await migrator.query('alter table audit_event disable row level security');
    try {
      expect(await findTableAccessViolations(migrator)).toContainEqual(
        expect.objectContaining({ table: 'audit_event', problem: 'rls_disabled' }),
      );
    } finally {
      await migrator.query('alter table audit_event enable row level security');
    }
  });

  it('flags a no-delete table (master data) whose DELETE or TRUNCATE was granted to the app role (AC-MD-06)', async () => {
    for (const privilege of ['DELETE', 'TRUNCATE']) {
      await migrator.query(`grant ${privilege} on zone to belgobeton_app`);
      try {
        expect(await findTableAccessViolations(migrator)).toContainEqual(
          expect.objectContaining({ table: 'zone', problem: 'delete_granted' }),
        );
      } finally {
        await migrator.query(`revoke ${privilege} on zone from belgobeton_app`);
      }
    }
  });

  it('flags an insert-only table (recette) whose UPDATE was granted to the app role (AC-MD-02)', async () => {
    await migrator.query('grant update on recette to belgobeton_app');
    try {
      expect(await findTableAccessViolations(migrator)).toContainEqual(
        expect.objectContaining({ table: 'recette', problem: 'update_granted' }),
      );
    } finally {
      await migrator.query('revoke update on recette from belgobeton_app');
    }
  });

  it('flags an auth-only table the app role could read', async () => {
    await migrator.query('grant select on login_attempt to belgobeton_app');
    try {
      expect(await findTableAccessViolations(migrator)).toContainEqual(
        expect.objectContaining({ table: 'login_attempt', problem: 'app_role_has_access' }),
      );
    } finally {
      await migrator.query('revoke select on login_attempt from belgobeton_app');
    }
  });

  it('flags a seed role that can insert outside the seed tables, update, or delete (T15 review)', async () => {
    for (const [grant, table] of [
      ['insert', 'parameter'],
      ['update', 'zone'],
      ['delete', 'zone'],
    ] as const) {
      await migrator.query(`grant ${grant} on ${table} to belgobeton_seed`);
      try {
        expect(await findTableAccessViolations(migrator)).toContainEqual(
          expect.objectContaining({ table, problem: 'seed_role_overreach' }),
        );
      } finally {
        await migrator.query(`revoke ${grant} on ${table} from belgobeton_seed`);
      }
    }
  });

  it('flags a system role that can insert into a seed table', async () => {
    await migrator.query('grant insert on zone to belgobeton_system');
    try {
      expect(await findTableAccessViolations(migrator)).toContainEqual(
        expect.objectContaining({ table: 'zone', problem: 'system_can_seed' }),
      );
    } finally {
      await migrator.query('revoke insert on zone from belgobeton_system');
    }
  });
});
