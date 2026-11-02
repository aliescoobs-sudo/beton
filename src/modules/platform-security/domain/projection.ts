import { policyRoleOf, type PolicyRole, type Role } from './permissions';

/** Per role, the fields it may see: 'all' or an allowlist. Anything not listed is dropped (default deny). */
export type Visibility<Row> = Record<PolicyRole, 'all' | readonly (keyof Row & string)[]>;

/** Declares an entity's field visibility next to its type (SPEC §4 layer 4, AC-SEC-05). */
export function defineVisibility<Row>(visibility: Visibility<Row>): Visibility<Row> {
  return visibility;
}

/** The row as `role` may see it. Use on every response that leaves a service for a role-restricted entity. */
export function project<Row extends object>(visibility: Visibility<Row>, role: Role, row: Row): Partial<Row> {
  // A V1 account is read as its policy role; a role with no policy role (driver, portals...) sees nothing.
  const policy = policyRoleOf(role);
  const allowed = policy ? visibility[policy] : [];
  if (allowed === 'all') return { ...row };
  const out: Partial<Row> = {};
  for (const field of allowed) if (field in row) out[field] = row[field];
  return out;
}

export function projectMany<Row extends object>(
  visibility: Visibility<Row>,
  role: Role,
  rows: Row[],
): Partial<Row>[] {
  return rows.map((row) => project(visibility, role, row));
}
