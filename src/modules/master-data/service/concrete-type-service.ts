import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import { parseConcreteTypeInput, parseConcreteTypeLabel, type ConcreteType } from '../domain/concrete-type';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type ConcreteTypeError = 'INVALID' | 'DUPLICATE_CODE' | 'NOT_FOUND';

const COLUMNS = 'id, code, label, status';

export async function listConcreteTypes(appPool: pg.Pool, actor: SessionUser): Promise<ConcreteType[]> {
  await require(appPool, actor, 'recettes.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<ConcreteType>(`select ${COLUMNS} from concrete_type order by code`),
  );
  return rows;
}

/** What a new order or recette may pick: archived types stay readable but are not offered. */
export async function listSelectableConcreteTypes(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<ConcreteType[]> {
  await require(appPool, actor, 'recettes.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<ConcreteType>(`select ${COLUMNS} from concrete_type where status = 'active' order by code`),
  );
  return rows;
}

export async function createConcreteType(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<ConcreteType, ConcreteTypeError>> {
  await require(appPool, actor, 'recettes.write');
  const parsed = parseConcreteTypeInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<ConcreteType>(
        `insert into concrete_type (id, code, label) values ($1, $2, $3) returning ${COLUMNS}`,
        [uuidv7(realClock.now()), parsed.value.code, parsed.value.label],
      ),
    );
    return ok(rows[0] as ConcreteType);
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE_CODE');
    throw error;
  }
}

/** Label and status; the code is immutable (trigger). */
export async function updateConcreteType(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  label: unknown,
  status?: ConcreteType['status'],
): Promise<Result<ConcreteType, ConcreteTypeError>> {
  await require(appPool, actor, 'recettes.write');
  const parsed = parseConcreteTypeLabel(label);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<ConcreteType>(
        `update concrete_type set label = $2, status = coalesce($3, status) where id = $1 returning ${COLUMNS}`,
        [id, parsed.value, status ?? null],
      ),
    );
    return rows[0] ? ok(rows[0]) : err('NOT_FOUND');
  } catch (error) {
    if (isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
