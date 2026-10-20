import type pg from 'pg';
import { TABLE_ACCESS } from '../domain/table-access';

export interface TableAccessViolation {
  table: string;
  problem:
    | 'not_registered'
    | 'missing_table'
    | 'rls_disabled'
    | 'rls_not_forced'
    | 'audit_trigger_missing'
    | 'app_role_has_access'
    | 'delete_granted'
    | 'update_granted';
}

/** Compares the live schema with TABLE_ACCESS (run as the migrator, which can see every table). */
export async function findTableAccessViolations(
  client: pg.Pool | pg.ClientBase,
): Promise<TableAccessViolation[]> {
  const { rows } = await client.query<{
    name: string;
    rls: boolean;
    forced: boolean;
    audited: boolean;
    app_access: boolean;
    app_delete: boolean;
    app_update: boolean;
  }>(`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
           exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'audit_capture') as audited,
           has_table_privilege('belgobeton_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as app_access,
           has_table_privilege('belgobeton_app', c.oid, 'DELETE, TRUNCATE') as app_delete,
           has_table_privilege('belgobeton_app', c.oid, 'UPDATE') as app_update
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')`);

  const violations: TableAccessViolation[] = [];
  const registry: Record<string, (typeof TABLE_ACCESS)[keyof typeof TABLE_ACCESS]> = TABLE_ACCESS;
  for (const t of rows) {
    const rule = registry[t.name];
    if (!rule) violations.push({ table: t.name, problem: 'not_registered' });
    else if (rule.kind === 'auth_only') {
      if (t.app_access) violations.push({ table: t.name, problem: 'app_role_has_access' });
    } else {
      if (!t.rls) violations.push({ table: t.name, problem: 'rls_disabled' });
      if (rule.force && !t.forced) violations.push({ table: t.name, problem: 'rls_not_forced' });
      if (rule.audited && !t.audited) violations.push({ table: t.name, problem: 'audit_trigger_missing' });
      if ('noDelete' in rule && rule.noDelete && t.app_delete) {
        violations.push({ table: t.name, problem: 'delete_granted' });
      }
      if ('insertOnly' in rule && rule.insertOnly && t.app_update) {
        violations.push({ table: t.name, problem: 'update_granted' });
      }
    }
  }
  const present = new Set(rows.map((r) => r.name));
  for (const name of Object.keys(TABLE_ACCESS)) {
    if (!present.has(name)) violations.push({ table: name, problem: 'missing_table' });
  }
  return violations;
}
