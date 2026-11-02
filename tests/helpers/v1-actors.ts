import pg from 'pg';
import { uuidv7 } from '../../src/lib/uuidv7';
import { realClock } from '../../src/modules/clock';
import { createPlant, updatePlant } from '../../src/modules/master-data';
import type { Role } from '../../src/modules/platform-security/domain/permissions';
import { USER_ROLES } from '../../src/modules/platform-security/domain/permissions';
import { realSessionUser } from './actors';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/**
 * One real account of every role. The plant manager is bound to a plant of its own, archived by `done()` so that the
 * tests that expect no active plant keep working. `ids` maps a role to its user id.
 */
export async function v1Actors(app: pg.Pool, migratorUrl: string, marker: string) {
  const migrator = new pg.Pool({ connectionString: migratorUrl, max: 1 });
  const owner = await realSessionUser(migratorUrl, 'owner');
  const ids = {} as Record<Role, string>;
  ids.owner = owner.id;
  let plantId: string | null = null;
  const made = await createPlant(app, owner, { code: letters(6), name: `VA ${marker}` });
  if (!made.ok) throw new Error('v1Actors: plant');
  plantId = made.value.id;
  for (const role of USER_ROLES) {
    if (role === 'owner') continue;
    const id = uuidv7(realClock.now());
    await migrator.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
       values ($1, $2, $3, true, $4, 'fr', 'active', true, now(), $5)`,
      [
        id,
        `${marker} ${role}`,
        `${marker}-${role}-${id}@belgobeton.test`,
        role,
        role === 'plant_manager' ? plantId : null,
      ],
    );
    ids[role] = id;
  }
  return {
    owner,
    ids,
    plantId,
    done: async () => {
      await updatePlant(app, owner, plantId as string, { status: 'archived' });
      await migrator.end();
    },
  };
}
