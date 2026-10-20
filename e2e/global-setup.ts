import pg from 'pg';
import { E2E_DATABASE, ensureRoles, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { testEnv } from '../tests/db-env';
import { E2E_BASE_URL, E2E_CSP, E2E_MD, E2E_OWNER, E2E_PASSWORD, E2E_PLANT, E2E_USERS } from './fixtures';

/** Fresh e2e database: an owner, a plant user and one partner per locale, none enrolled yet. */
export default async function globalSetup() {
  const env = { ...testEnv(E2E_DATABASE), APP_BASE_URL: E2E_BASE_URL };
  await ensureRoles(env);
  await recreateDatabase(env, E2E_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);

  const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
  try {
    const auth = createAuth({ authPool, env, log: () => undefined });
    const bootstrap = { userId: BOOTSTRAP_ACTOR_ID, role: 'system' as const };
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_OWNER,
      password: E2E_PASSWORD,
      role: 'owner',
      locale: 'fr',
    });
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_PLANT,
      password: E2E_PASSWORD,
      role: 'plant',
      locale: 'fr',
    });
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_CSP,
      password: E2E_PASSWORD,
      role: 'office',
      locale: 'fr',
    });
    for (const [user, role, locale] of [
      [E2E_MD.partnerFr, 'partner', 'fr'],
      [E2E_MD.partnerAr, 'partner', 'ar'],
      [E2E_MD.office, 'office', 'fr'],
    ] as const) {
      await createUser(auth, authPool, {
        actor: bootstrap,
        email: user.email,
        name: user.name,
        password: E2E_PASSWORD,
        role,
        locale,
      });
    }
    for (const [locale, user] of Object.entries(E2E_USERS)) {
      await createUser(auth, authPool, {
        actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
        email: user.email,
        name: user.name,
        password: E2E_PASSWORD,
        role: 'partner',
        locale: locale as 'fr' | 'ar',
      });
    }
  } finally {
    await authPool.end();
  }
}
