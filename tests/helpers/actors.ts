import pg from 'pg';
import { realClock } from '../../src/modules/clock';
import { uuidv7 } from '../../src/lib/uuidv7';
import type { Role } from '../../src/modules/platform-security/domain/permissions';

export interface TestActor {
  id: string;
  role: Role;
  name: string;
  email: string;
}

/**
 * A real, active account for request contexts in tests (the database checks the request role against the stored
 * role, DECISIONS 76). There is a single owner: it is reused when it exists.
 */
export async function realActor(migratorUrl: string, role: Role): Promise<TestActor> {
  const pool = new pg.Pool({ connectionString: migratorUrl, max: 1 });
  try {
    if (role === 'owner') {
      const { rows } = await pool.query<TestActor>(
        `select id, role, name, email from "user" where role = 'owner'`,
      );
      if (rows[0]) return rows[0];
    }
    const id = uuidv7(realClock.now());
    const email = `actor-${role}-${id}@belgobeton.test`;
    await pool.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
       values ($1, $2, $3, true, $4, 'fr', 'active', true, now())`,
      [id, `Test ${role}`, email, role],
    );
    return { id, role, name: `Test ${role}`, email };
  } finally {
    await pool.end();
  }
}

/** The same real account, shaped as the session user that services receive. */
export async function realSessionUser(
  migratorUrl: string,
  role: Role,
): Promise<{
  id: string;
  name: string;
  email: string;
  role: Role;
  locale: 'fr' | 'ar';
  twoFactorEnabled: boolean;
  reenrolRequired: boolean;
}> {
  const actor = await realActor(migratorUrl, role);
  return { ...actor, locale: 'fr', twoFactorEnabled: true, reenrolRequired: false };
}
