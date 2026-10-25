import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import { parseSupplierInput, type Supplier } from '../domain/supplier';
import { defaultFieldCipher, type FieldCipher } from './field-cipher';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type SupplierError = 'INVALID' | 'DUPLICATE_ICE' | 'NOT_FOUND';

export interface SupplierDeps {
  cipher?: FieldCipher;
}

interface SupplierRow {
  id: string;
  code: string;
  name: string;
  category: Supplier['category'];
  ice: string | null;
  phone_enc: string | null;
  payment_terms_days: number;
  lead_time_days: number | null;
  status: Supplier['status'];
}

const COLUMNS = 'id, code, name, category, ice, phone_enc, payment_terms_days, lead_time_days, status';

const toSupplier = (row: SupplierRow, cipher: FieldCipher): Supplier => ({
  id: row.id,
  code: row.code,
  name: row.name,
  category: row.category,
  ice: row.ice,
  phone: cipher.open(row.phone_enc),
  paymentTermsDays: row.payment_terms_days,
  leadTimeDays: row.lead_time_days,
  status: row.status,
});

export async function listSuppliers(
  appPool: pg.Pool,
  actor: SessionUser,
  { cipher = defaultFieldCipher() }: SupplierDeps = {},
): Promise<Supplier[]> {
  await require(appPool, actor, 'parties.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<SupplierRow>(`select ${COLUMNS} from supplier order by code`),
  );
  return rows.map((row) => toSupplier(row, cipher));
}

function failure(error: unknown): SupplierError {
  const code = (error as { code?: string }).code;
  if (isUniqueViolation(error)) return 'DUPLICATE_ICE';
  if (code === '22P02') return 'NOT_FOUND';
  throw error;
}

export async function createSupplier(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  { cipher = defaultFieldCipher() }: SupplierDeps = {},
): Promise<Result<Supplier, SupplierError>> {
  await require(appPool, actor, 'parties.write');
  const parsed = parseSupplierInput(input);
  if (!parsed.ok) return err('INVALID');
  const value = parsed.value;
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const { rows: seq } = await tx.query<{ code: string }>(`select public.next_code('FRN', 2) as code`);
      const { rows } = await tx.query<SupplierRow>(
        `insert into supplier (id, code, name, category, ice, phone_enc, payment_terms_days, lead_time_days)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
        [
          uuidv7(realClock.now()),
          seq[0]!.code,
          value.name,
          value.category,
          value.ice ?? null,
          cipher.seal(value.phone ?? null),
          value.paymentTermsDays,
          value.leadTimeDays ?? null,
        ],
      );
      return ok(toSupplier(rows[0]!, cipher));
    });
  } catch (error) {
    return err(failure(error));
  }
}

export async function updateSupplier(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  input: unknown,
  { cipher = defaultFieldCipher() }: SupplierDeps = {},
): Promise<Result<Supplier, SupplierError>> {
  await require(appPool, actor, 'parties.write');
  const parsed = parseSupplierInput(input);
  if (!parsed.ok) return err('INVALID');
  const value = parsed.value;
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const { rows: current } = await tx.query<SupplierRow>(
        `select ${COLUMNS} from supplier where id = $1 for update`,
        [id],
      );
      if (!current[0]) return err('NOT_FOUND' as const);
      // An unchanged phone keeps its ciphertext, so an unrelated edit leaves no phone trace in the audit log.
      const phone = value.phone ?? null;
      const phoneEnc =
        phone === cipher.open(current[0].phone_enc) ? current[0].phone_enc : cipher.seal(phone);
      const { rows } = await tx.query<SupplierRow>(
        `update supplier set name = $2, category = $3, ice = $4, phone_enc = $5, payment_terms_days = $6, lead_time_days = $7
          where id = $1 returning ${COLUMNS}`,
        [
          id,
          value.name,
          value.category,
          value.ice ?? null,
          phoneEnc,
          value.paymentTermsDays,
          value.leadTimeDays ?? null,
        ],
      );
      return ok(toSupplier(rows[0]!, cipher));
    });
  } catch (error) {
    return err(failure(error));
  }
}

/** Archiving replaces deleting; owner/partner only. */
export async function archiveSupplier(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
): Promise<Result<true, 'NOT_FOUND'>> {
  await require(appPool, actor, 'parties.archive');
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const { rows } = await tx.query(
        `update supplier set status = 'archived' where id = $1 and status = 'active' returning id`,
        [id],
      );
      if (!rows[0]) return err('NOT_FOUND' as const);
      await tx.query(
        `select audit.record('archive', 'supplier', $1, null, jsonb_build_object('status', 'archived'), null)`,
        [id],
      );
      return ok(true as const);
    });
  } catch (error) {
    if (isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
