import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import { parseZoneInput, type Zone } from '../domain/zone';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type ZoneError = 'INVALID' | 'DUPLICATE_NAME' | 'NOT_FOUND';

interface ZoneRow {
  id: string;
  name: string;
  one_way_min: number;
}

const toZone = (row: ZoneRow): Zone => ({ id: row.id, name: row.name, oneWayMin: row.one_way_min });

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
    if (isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
