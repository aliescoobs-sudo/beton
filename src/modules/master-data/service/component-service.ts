import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import {
  parseComponentInput,
  parsePurchaseUnitInput,
  type Component,
  type PurchaseUnit,
} from '../domain/component';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type ComponentError = 'INVALID' | 'DUPLICATE_NAME' | 'NOT_FOUND';

interface ComponentRow {
  id: string;
  code: string;
  name_fr: string;
  name_ar: string;
  base_unit: Component['baseUnit'];
  low_stock_threshold: string;
  status: Component['status'];
}

interface UnitRow {
  id: string;
  component_id: string;
  label: string;
  factor_to_base: number;
  status: PurchaseUnit['status'];
}

const COMPONENT_COLUMNS = 'id, code, name_fr, name_ar, base_unit, low_stock_threshold, status';
const UNIT_COLUMNS = 'id, component_id, label, factor_to_base, status';

const toComponent = (row: ComponentRow): Component => ({
  id: row.id,
  code: row.code,
  nameFr: row.name_fr,
  nameAr: row.name_ar,
  baseUnit: row.base_unit,
  lowStockThreshold: Number(row.low_stock_threshold),
  status: row.status,
});

const toUnit = (row: UnitRow): PurchaseUnit => ({
  id: row.id,
  componentId: row.component_id,
  label: row.label,
  factorToBase: row.factor_to_base,
  status: row.status,
});

export async function listComponents(appPool: pg.Pool, actor: SessionUser): Promise<Component[]> {
  await require(appPool, actor, 'components.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<ComponentRow>(`select ${COMPONENT_COLUMNS} from component order by code`),
  );
  return rows.map(toComponent);
}

export async function listPurchaseUnits(appPool: pg.Pool, actor: SessionUser): Promise<PurchaseUnit[]> {
  await require(appPool, actor, 'components.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<UnitRow>(
      `select ${UNIT_COLUMNS} from purchase_unit order by component_id, factor_to_base, label`,
    ),
  );
  return rows.map(toUnit);
}

function failure(error: unknown): ComponentError {
  if (isUniqueViolation(error)) return 'DUPLICATE_NAME';
  // 22P02 malformed id; 23503 the component of a new purchase unit does not exist.
  if (isMalformedId(error) || (error as { code?: string }).code === '23503') return 'NOT_FOUND';
  throw error;
}

export async function createComponent(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<Component, ComponentError>> {
  await require(appPool, actor, 'components.write');
  const parsed = parseComponentInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<ComponentRow>(
        `insert into component (id, code, name_fr, name_ar, base_unit, low_stock_threshold)
         values ($1, public.next_code('CMP', 2), $2, $3, $4, $5) returning ${COMPONENT_COLUMNS}`,
        [uuidv7(realClock.now()), v.nameFr, v.nameAr, v.baseUnit, v.lowStockThreshold],
      ),
    );
    return ok(toComponent(rows[0] as ComponentRow));
  } catch (error) {
    return err(failure(error));
  }
}

/** Names and threshold; code and base unit are immutable (trigger). `status` archives or restores. */
export async function updateComponent(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  input: unknown,
  status?: Component['status'],
): Promise<Result<Component, ComponentError>> {
  await require(appPool, actor, 'components.write');
  const parsed = parseComponentInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<ComponentRow>(
        `update component set name_fr = $2, name_ar = $3, base_unit = $4, low_stock_threshold = $5,
           status = coalesce($6, status)
         where id = $1 returning ${COMPONENT_COLUMNS}`,
        [id, v.nameFr, v.nameAr, v.baseUnit, v.lowStockThreshold, status ?? null],
      ),
    );
    return rows[0] ? ok(toComponent(rows[0])) : err('NOT_FOUND');
  } catch (error) {
    return err(failure(error));
  }
}

export async function createPurchaseUnit(
  appPool: pg.Pool,
  actor: SessionUser,
  componentId: string,
  input: unknown,
): Promise<Result<PurchaseUnit, ComponentError>> {
  await require(appPool, actor, 'components.write');
  const parsed = parsePurchaseUnitInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<UnitRow>(
        `insert into purchase_unit (id, component_id, label, factor_to_base) values ($1, $2, $3, $4)
         returning ${UNIT_COLUMNS}`,
        [uuidv7(realClock.now()), componentId, parsed.value.label, parsed.value.factorToBase],
      ),
    );
    return ok(toUnit(rows[0] as UnitRow));
  } catch (error) {
    return err(failure(error));
  }
}

/** Label and status only: the factor never changes (a different factor is a new unit). */
export async function updatePurchaseUnit(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  label: unknown,
  status?: PurchaseUnit['status'],
): Promise<Result<PurchaseUnit, ComponentError>> {
  await require(appPool, actor, 'components.write');
  const parsed = parsePurchaseUnitInput({ label, factorToBase: 1 });
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<UnitRow>(
        `update purchase_unit set label = $2, status = coalesce($3, status) where id = $1
         returning ${UNIT_COLUMNS}`,
        [id, parsed.value.label, status ?? null],
      ),
    );
    return rows[0] ? ok(toUnit(rows[0])) : err('NOT_FOUND');
  } catch (error) {
    return err(failure(error));
  }
}
