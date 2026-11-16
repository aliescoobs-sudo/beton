// T20: what every step of the twin seed shares: the pools, the accounts the training base created, the plants, the calendar and the pseudo-random generator.
import pg from 'pg';
import type { Env } from '../../../src/lib/env.ts';
import { TRAINING_EMAIL_DOMAIN } from '../../../src/lib/training.ts';
import { createRng, type Rng } from '../../../src/modules/ledger/domain/scenario.ts';
import type { SessionUser } from '../../../src/modules/platform-security/auth/session-gate.ts';

export type TwinSeedEnv = Env & { DATABASE_URL_SEED: string; DATABASE_URL_MIGRATOR: string };

export interface Pools {
  app: pg.Pool;
  seed: pg.Pool;
  migrator: pg.Pool;
}

export interface Plants {
  TET: { id: string; code: string };
  CHF: { id: string; code: string };
}

export interface TwinContext {
  env: TwinSeedEnv;
  pools: Pools;
  anchor: string;
  rng: Rng;
  owner: SessionUser;
  /** The office accounts of the training base: Responsable (sales) and Assistante (purchases). */
  sales: SessionUser;
  purchases: SessionUser;
  admin: SessionUser;
  plantManagers: { TET: SessionUser; CHF: SessionUser };
  plants: Plants;
}

export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const weekday = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
export const isWorkingDay = (iso: string): boolean => weekday(iso) !== 0;
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export class TwinSeedError extends Error {}
export function must<T>(label: string, r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new TwinSeedError(`twin seed: ${label} failed (${r.error})`);
  return r.value;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  plant_id: string | null;
}

const asSession = (u: UserRow): SessionUser =>
  ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    locale: 'fr',
    twoFactorEnabled: false,
    reenrolRequired: false,
    stepUpVerified: true, // the seed stands for requests that passed the step-up, as the training seed does
    ...(u.plant_id ? { plantId: u.plant_id } : {}),
  }) as unknown as SessionUser;

/** The accounts the existing fictitious-account script made (scripts/seed-training.ts, PASSWORD_ACCOUNTS): found by their reserved address, never created here. */
export async function loadAccounts(
  migrator: pg.Pool,
): Promise<Pick<TwinContext, 'owner' | 'sales' | 'purchases' | 'admin' | 'plantManagers'>> {
  const { rows } = await migrator.query<UserRow>(
    `select id, name, email, role, null::uuid as plant_id from "user" where lower(email) like $1`,
    [`%@${TRAINING_EMAIL_DOMAIN}`],
  );
  const by = (login: string): UserRow => {
    const row = rows.find((r) => r.email.toLowerCase() === `${login}@${TRAINING_EMAIL_DOMAIN}`);
    if (!row)
      throw new TwinSeedError(
        `twin seed refused: the account ${login} is missing (run the training seed with TRAINING_SEED_PROFILE=twin-base first)`,
      );
    return row;
  };
  const plantOf = async (code: string): Promise<string> =>
    (await migrator.query<{ id: string }>('select id from plant where code = $1', [code])).rows[0]!.id;
  return {
    owner: asSession(by('proprietaire')),
    admin: asSession(by('admin')),
    sales: asSession(by('ventes')),
    purchases: asSession(by('achats')),
    plantManagers: {
      TET: asSession({ ...by('centrale-tetouan'), plant_id: await plantOf('TETOUAN') }),
      CHF: asSession({ ...by('centrale-chefchaouen'), plant_id: await plantOf('CHEFCHN') }),
    },
  };
}

export async function loadPlants(migrator: pg.Pool): Promise<Plants> {
  const { rows } = await migrator.query<{ id: string; code: string }>('select id, code from plant');
  const tet = rows.find((r) => r.code === 'TETOUAN');
  const chf = rows.find((r) => r.code === 'CHEFCHN');
  if (!tet || !chf)
    throw new TwinSeedError('twin seed refused: the two plants of the training base are missing');
  return { TET: tet, CHF: chf };
}

export { createRng };
