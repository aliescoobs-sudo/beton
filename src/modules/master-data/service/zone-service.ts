import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import {
  auditDenied,
  can,
  ForbiddenError,
  type Permission,
  type SessionUser,
} from '@/modules/platform-security';
import { parseZoneInput, type Zone } from '../domain/zone';

export type ZoneError = 'INVALID' | 'DUPLICATE_NAME' | 'NOT_FOUND';

interface ZoneRow {
  id: string;
  name: string;
  one_way_min: number;
}

const toZone = (row: ZoneRow): Zone => ({ id: row.id, name: row.name, oneWayMin: row.one_way_min });

const inRequest = <T>(pool: pg.Pool, actor: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(pool, { userId: actor.id, role: actor.role, requestId: uuidv7(realClock.now()) }, fn);

/** Layer 2 of SPEC-platform-security §4: the service checks the permission again, whatever the route did. */
async function require(pool: pg.Pool, actor: SessionUser, permission: Permission): Promise<void> {
  if (can(actor.role, permission)) return;
  await auditDenied(pool, actor, permission);
  throw new ForbiddenError();
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';

export async function listZones(appPool: pg.Pool, actor: SessionUser): Promise<Zone[]> {
  await require(appPool, actor, 'zones.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<ZoneRow>('select id, name, one_way_min from zone order by one_way_min, lower(name)'),
  );
  return rows.map(toZone);
}

export async function createZone(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<Zone, ZoneError>> {
  await require(appPool, actor, 'zones.write');
  const parsed = parseZoneInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<ZoneRow>(
        'insert into zone (id, name, one_way_min) values ($1, $2, $3) returning id, name, one_way_min',
        [uuidv7(realClock.now()), parsed.value.name, parsed.value.oneWayMin],
      ),
    );
    return ok(toZone(rows[0] as ZoneRow));
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE_NAME');
    throw error;
  }
}

export async function updateZone(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  input: unknown,
): Promise<Result<Zone, ZoneError>> {
  await require(appPool, actor, 'zones.write');
  const parsed = parseZoneInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<ZoneRow>(
        'update zone set name = $2, one_way_min = $3 where id = $1 returning id, name, one_way_min',
        [id, parsed.value.name, parsed.value.oneWayMin],
      ),
    );
    return rows[0] ? ok(toZone(rows[0])) : err('NOT_FOUND');
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE_NAME');
    // A malformed id is a NOT_FOUND to the caller, not a server error.
    if ((error as { code?: string }).code === '22P02') return err('NOT_FOUND');
    throw error;
  }
}
