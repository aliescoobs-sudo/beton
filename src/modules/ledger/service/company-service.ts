import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { type CompanyProfile, parseCompanyProfileInput } from '../domain/company';

interface Row {
  effective_from: string;
  legal_name: string;
  legal_form: string;
  ice: string;
  if_number: string;
  rc_number: string;
  patente: string;
  address: string;
  phone: string | null;
  email: string | null;
  rib: string | null;
}
const COLUMNS = `to_char(effective_from, 'YYYY-MM-DD') as effective_from, legal_name, legal_form, ice, if_number, rc_number,
  patente, address, phone, email, rib`;
const toProfile = (r: Row): CompanyProfile => ({
  effectiveFrom: r.effective_from,
  legalName: r.legal_name,
  legalForm: r.legal_form,
  ice: r.ice,
  ifNumber: r.if_number,
  rcNumber: r.rc_number,
  patente: r.patente,
  address: r.address,
  phone: r.phone,
  email: r.email,
  rib: r.rib,
});

/** Our legal identity in force on `today`: the latest version that has started, or null before the owner enters it. */
export async function getCompanyProfile(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string },
): Promise<CompanyProfile | null> {
  await require(appPool, actor, 'company.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Row>(
      `select ${COLUMNS} from company_profile where effective_from <= $1 order by effective_from desc, created_at desc limit 1`,
      [deps.today],
    ),
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

/** Every version, newest first (the history the owner can look back on). */
export async function listCompanyProfiles(appPool: pg.Pool, actor: SessionUser): Promise<CompanyProfile[]> {
  await require(appPool, actor, 'company.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Row>(`select ${COLUMNS} from company_profile order by effective_from desc, created_at desc`),
  );
  return rows.map(toProfile);
}

/** A change of identity is a new version, audited; nothing is ever edited. Owner only. */
export async function saveCompanyProfile(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<{ id: string }, 'INVALID' | 'LEGAL_BLOCK_TOO_LONG'>> {
  await require(appPool, actor, 'company.write');
  const parsed = parseCompanyProfileInput(input);
  if (!parsed.ok) return err(parsed.error);
  const v = parsed.value;
  const id = randomUUID();
  await inRequest(appPool, actor, (tx) =>
    tx.query(
      `insert into company_profile (id, effective_from, legal_name, legal_form, ice, if_number, rc_number, patente, address,
                                    phone, email, rib, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        v.effectiveFrom ?? deps.today,
        v.legalName,
        v.legalForm,
        v.ice,
        v.ifNumber,
        v.rcNumber,
        v.patente,
        v.address,
        v.phone,
        v.email,
        v.rib ?? null,
        actor.id,
      ],
    ),
  );
  return ok({ id });
}
