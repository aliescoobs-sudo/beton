import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import { parsePlantInput, type Plant } from '../domain/plant';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type PlantError = 'INVALID' | 'DUPLICATE' | 'NOT_FOUND' | 'LAST_ACTIVE';

interface PlantRow {
  id: string;
  code: string;
  name: string;
  status: Plant['status'];
}
const toPlant = (r: PlantRow): Plant => ({ id: r.id, code: r.code, name: r.name, status: r.status });

/**
 * Sets the plant of the request on a transaction already inside `inRequest`: rows inserted next that need a plant and
 * do not name one take this one (the database trigger `plant_fill`). A plant manager's own plant, or the plant a person
 * picked on a screen. It is a context value, not a right: what a role may read is decided by row-level security.
 */
export async function usePlant(tx: pg.PoolClient, plantId: string | null | undefined): Promise<void> {
  if (!plantId) return;
  await tx.query(`select set_config('app.plant_id', $1, true)`, [plantId]);
}

/** The plant a request names in its input (`plantId`, a UUID), or null. Never throws: a bad value is no plant. */
export function plantIdOf(input: unknown): string | null {
  const v = (input as { plantId?: unknown } | null | undefined)?.plantId;
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v
    : null;
}

export async function listPlants(appPool: pg.Pool, actor: SessionUser): Promise<Plant[]> {
  await require(appPool, actor, 'plants.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<PlantRow>('select id, code, name, status from plant order by code'),
  );
  return rows.map(toPlant);
}

export async function createPlant(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<Plant, PlantError>> {
  await require(appPool, actor, 'plants.write');
  const parsed = parsePlantInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<PlantRow>(
        `insert into plant (id, code, name, created_by) values ($1, $2, $3, $4) returning id, code, name, status`,
        [uuidv7(realClock.now()), parsed.value.code, parsed.value.name, actor.id],
      ),
    );
    return ok(toPlant(rows[0] as PlantRow));
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE');
    throw error;
  }
}

/** Renames a plant, or archives it (never deleted). The last active plant cannot be archived while others have rows. */
export async function updatePlant(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  changes: { name?: string; status?: Plant['status'] },
): Promise<Result<Plant, PlantError>> {
  await require(appPool, actor, 'plants.write');
  const name = changes.name === undefined ? null : parsePlantInput({ code: 'XX', name: changes.name });
  if (name && !name.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<PlantRow>(
        `update plant set name = coalesce($2, name), status = coalesce($3, status) where id = $1
         returning id, code, name, status`,
        [id, name?.ok ? name.value.name : null, changes.status ?? null],
      ),
    );
    return rows[0] ? ok(toPlant(rows[0])) : err('NOT_FOUND');
  } catch (error) {
    if (isMalformedId(error)) return err('NOT_FOUND');
    if (isUniqueViolation(error)) return err('DUPLICATE');
    throw error;
  }
}
