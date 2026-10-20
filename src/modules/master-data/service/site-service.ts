import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import { type ClientSite, parseSiteInput } from '../domain/site';
import { defaultFieldCipher, type FieldCipher } from './field-cipher';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type SiteError = 'INVALID' | 'DUPLICATE_LABEL' | 'NOT_FOUND';

export interface SiteDeps {
  cipher?: FieldCipher;
}

interface SiteRow {
  id: string;
  client_id: string;
  label: string;
  address_enc: string | null;
  zone_id: string | null;
}

const COLUMNS = 'id, client_id, label, address_enc, zone_id';

const toSite = (row: SiteRow, cipher: FieldCipher): ClientSite => ({
  id: row.id,
  clientId: row.client_id,
  label: row.label,
  address: cipher.open(row.address_enc),
  zoneId: row.zone_id,
});

export async function listSites(
  appPool: pg.Pool,
  actor: SessionUser,
  clientId: string,
  { cipher = defaultFieldCipher() }: SiteDeps = {},
): Promise<ClientSite[]> {
  await require(appPool, actor, 'parties.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<SiteRow>(`select ${COLUMNS} from client_site where client_id = $1 order by lower(label)`, [
        clientId,
      ]),
    );
    return rows.map((row) => toSite(row, cipher));
  } catch (error) {
    if (isMalformedId(error)) return [];
    throw error;
  }
}

/** Shared by create and update: the database errors that mean "bad input" rather than "broken server". */
function failure(error: unknown): SiteError {
  const code = (error as { code?: string }).code;
  if (isUniqueViolation(error)) return 'DUPLICATE_LABEL';
  if (code === '23503' || code === '22P02') return 'NOT_FOUND';
  throw error;
}

export async function createSite(
  appPool: pg.Pool,
  actor: SessionUser,
  clientId: string,
  input: unknown,
  { cipher = defaultFieldCipher() }: SiteDeps = {},
): Promise<Result<ClientSite, SiteError>> {
  await require(appPool, actor, 'parties.write');
  const parsed = parseSiteInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<SiteRow>(
        `insert into client_site (id, client_id, label, address_enc, zone_id) values ($1, $2, $3, $4, $5)
         returning ${COLUMNS}`,
        [
          uuidv7(realClock.now()),
          clientId,
          parsed.value.label,
          cipher.seal(parsed.value.address ?? null),
          parsed.value.zoneId ?? null,
        ],
      ),
    );
    return ok(toSite(rows[0]!, cipher));
  } catch (error) {
    return err(failure(error));
  }
}

export async function updateSite(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  input: unknown,
  { cipher = defaultFieldCipher() }: SiteDeps = {},
): Promise<Result<ClientSite, SiteError>> {
  await require(appPool, actor, 'parties.write');
  const parsed = parseSiteInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const { rows: current } = await tx.query<SiteRow>(
        `select ${COLUMNS} from client_site where id = $1 for update`,
        [id],
      );
      if (!current[0]) return err('NOT_FOUND' as const);
      // An unchanged address keeps its ciphertext, so an unrelated edit leaves no trace of it in the audit log.
      const address = parsed.value.address ?? null;
      const sealed =
        address === cipher.open(current[0].address_enc) ? current[0].address_enc : cipher.seal(address);
      const { rows } = await tx.query<SiteRow>(
        `update client_site set label = $2, address_enc = $3, zone_id = $4 where id = $1 returning ${COLUMNS}`,
        [id, parsed.value.label, sealed, parsed.value.zoneId ?? null],
      );
      return ok(toSite(rows[0]!, cipher));
    });
  } catch (error) {
    return err(failure(error));
  }
}
