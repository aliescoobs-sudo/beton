import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import { type Client, parseClientInput } from '../domain/client';
import { normalizeIce, normalizeName } from '../domain/party';
import { defaultFieldCipher, type FieldCipher } from './field-cipher';
import { inRequest, isMalformedId, isUniqueViolation, require } from './request';

export type ClientError = 'INVALID' | 'DUPLICATE_ICE' | 'NOT_FOUND';

/** Enough to point at the existing client instead of creating a second one. */
export interface ClientRef {
  id: string;
  code: string;
  name: string;
  status: Client['status'];
}

export interface ClientDeps {
  cipher?: FieldCipher;
}

interface ClientRow {
  id: string;
  code: string;
  name: string;
  kind: Client['kind'];
  ice: string | null;
  ice_override_reason: string | null;
  phone_enc: string | null;
  contact_name: string | null;
  default_zone_id: string | null;
  payment_terms_days: number;
  notes: string | null;
  status: Client['status'];
}

const COLUMNS = `id, code, name, kind, ice, ice_override_reason, phone_enc, contact_name, default_zone_id,
  payment_terms_days, notes, status`;

const toClient = (row: ClientRow, cipher: FieldCipher): Client => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind,
  ice: row.ice,
  iceOverrideReason: row.ice_override_reason,
  phone: cipher.open(row.phone_enc),
  contactName: row.contact_name,
  defaultZoneId: row.default_zone_id,
  paymentTermsDays: row.payment_terms_days,
  notes: row.notes,
  status: row.status,
});

export async function listClients(
  appPool: pg.Pool,
  actor: SessionUser,
  { cipher = defaultFieldCipher() }: ClientDeps = {},
): Promise<Client[]> {
  await require(appPool, actor, 'parties.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<ClientRow>(`select ${COLUMNS} from client order by code`),
  );
  return rows.map((row) => toClient(row, cipher));
}

/** Clients a new order can pick: archived ones are excluded here, but stay readable everywhere else. */
export async function listSelectableClients(
  appPool: pg.Pool,
  actor: SessionUser,
  { cipher = defaultFieldCipher() }: ClientDeps = {},
): Promise<Client[]> {
  await require(appPool, actor, 'parties.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<ClientRow>(`select ${COLUMNS} from client where status = 'active' order by lower(name), code`),
  );
  return rows.map((row) => toClient(row, cipher));
}

export async function getClient(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  { cipher = defaultFieldCipher() }: ClientDeps = {},
): Promise<Client | null> {
  await require(appPool, actor, 'parties.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<ClientRow>(`select ${COLUMNS} from client where id = $1`, [id]),
    );
    return rows[0] ? toClient(rows[0], cipher) : null;
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}

/** The client holding this ICE (typed as the user wrote it), for the "add a site there instead" hint. */
export async function findClientByIce(
  appPool: pg.Pool,
  actor: SessionUser,
  rawIce: string,
): Promise<ClientRef | null> {
  await require(appPool, actor, 'parties.read');
  const ice = normalizeIce(rawIce);
  if (ice === null) return null;
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<ClientRef>(`select id, code, name, status from client where ice = $1 order by code limit 1`, [
      ice,
    ]),
  );
  return rows[0] ?? null;
}

async function duplicateOf(tx: pg.PoolClient, ice: string, exceptId: string | null): Promise<boolean> {
  const { rowCount } = await tx.query(
    `select 1 from client where ice = $1 and ($2::uuid is null or id <> $2::uuid)`,
    [ice, exceptId],
  );
  return (rowCount ?? 0) > 0;
}

/** Same normalized name as an existing client: shown as a warning, never a block. */
async function similarClients(
  tx: pg.PoolClient,
  name: string,
  exceptId: string | null,
): Promise<ClientRef[]> {
  const { rows } = await tx.query<ClientRef>(
    `select id, code, name, status from client where ($1::uuid is null or id <> $1::uuid) order by code`,
    [exceptId],
  );
  const wanted = normalizeName(name);
  return rows.filter((row) => normalizeName(row.name) === wanted);
}

export interface SavedClient {
  client: Client;
  /** Existing clients with a similar name: a hint to double-check, the client is saved anyway. */
  similar: ClientRef[];
}

/**
 * A matching ICE blocks creation (DUPLICATE_ICE); an owner/partner can accept the second client by giving a
 * reason, which is stored on the row and therefore in its audit event. Office giving a reason is refused.
 */
export async function createClient(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  { cipher = defaultFieldCipher() }: ClientDeps = {},
): Promise<Result<SavedClient, ClientError>> {
  await require(appPool, actor, 'parties.write');
  const parsed = parseClientInput(input);
  if (!parsed.ok) return err('INVALID');
  const value = parsed.value;
  if (value.iceOverrideReason !== undefined) await require(appPool, actor, 'parties.ice_override');
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const duplicate = value.ice !== undefined && (await duplicateOf(tx, value.ice, null));
      if (duplicate && value.iceOverrideReason === undefined) return err('DUPLICATE_ICE' as const);
      const similar = await similarClients(tx, value.name, null);
      const { rows: seq } = await tx.query<{ code: string }>(`select public.next_code('CLT', 3) as code`);
      const { rows } = await tx.query<ClientRow>(
        `insert into client (id, code, name, kind, ice, ice_override_reason, phone_enc, contact_name,
                             default_zone_id, payment_terms_days, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${COLUMNS}`,
        [
          uuidv7(realClock.now()),
          seq[0]!.code,
          value.name,
          value.kind,
          value.ice ?? null,
          duplicate ? (value.iceOverrideReason ?? null) : null,
          cipher.seal(value.phone ?? null),
          value.contactName ?? null,
          value.defaultZoneId ?? null,
          value.paymentTermsDays,
          value.notes ?? null,
        ],
      );
      return ok({ client: toClient(rows[0]!, cipher), similar });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE_ICE');
    // default_zone_id that is not a zone
    if ((error as { code?: string }).code === '23503') return err('INVALID');
    throw error;
  }
}

/** Edits everything but the code and the status. Changing the ICE runs the same duplicate guard as creation. */
export async function updateClient(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  input: unknown,
  { cipher = defaultFieldCipher() }: ClientDeps = {},
): Promise<Result<SavedClient, ClientError>> {
  await require(appPool, actor, 'parties.write');
  const parsed = parseClientInput(input);
  if (!parsed.ok) return err('INVALID');
  const value = parsed.value;
  if (value.iceOverrideReason !== undefined) await require(appPool, actor, 'parties.ice_override');
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const { rows: current } = await tx.query<ClientRow>(
        `select ${COLUMNS} from client where id = $1 for update`,
        [id],
      );
      const before = current[0];
      if (!before) return err('NOT_FOUND' as const);

      const iceChanged = (value.ice ?? null) !== before.ice;
      let overrideReason = before.ice_override_reason;
      if (iceChanged) {
        const duplicate = value.ice !== undefined && (await duplicateOf(tx, value.ice, id));
        if (duplicate && value.iceOverrideReason === undefined) return err('DUPLICATE_ICE' as const);
        overrideReason = duplicate ? (value.iceOverrideReason ?? null) : null;
      }
      // Dropping or changing an existing override is the owner/partner's call too.
      if (overrideReason !== before.ice_override_reason)
        await require(appPool, actor, 'parties.ice_override');

      // Keep the stored ciphertext when the phone did not change, so an unrelated edit leaves no phone trace.
      const phone = value.phone ?? null;
      const phoneEnc = phone === cipher.open(before.phone_enc) ? before.phone_enc : cipher.seal(phone);
      const similar = await similarClients(tx, value.name, id);
      const { rows } = await tx.query<ClientRow>(
        `update client set name = $2, kind = $3, ice = $4, ice_override_reason = $5, phone_enc = $6,
                contact_name = $7, default_zone_id = $8, payment_terms_days = $9, notes = $10
          where id = $1 returning ${COLUMNS}`,
        [
          id,
          value.name,
          value.kind,
          value.ice ?? null,
          overrideReason,
          phoneEnc,
          value.contactName ?? null,
          value.defaultZoneId ?? null,
          value.paymentTermsDays,
          value.notes ?? null,
        ],
      );
      return ok({ client: toClient(rows[0]!, cipher), similar });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE_ICE');
    const code = (error as { code?: string }).code;
    // not a zone, malformed id, or a kind/ICE combination the table refuses
    if (code === '23503' || code === '23514') return err('INVALID');
    if (isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

/** Archiving replaces deleting: the client leaves the selectable list but every record keeps pointing at it. */
export async function archiveClient(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
): Promise<Result<true, 'NOT_FOUND'>> {
  await require(appPool, actor, 'parties.archive');
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const { rows } = await tx.query<{ code: string }>(
        `update client set status = 'archived' where id = $1 and status = 'active' returning code`,
        [id],
      );
      if (!rows[0]) return err('NOT_FOUND' as const);
      await tx.query(
        `select audit.record('archive', 'client', $1, null, jsonb_build_object('status', 'archived'), null)`,
        [id],
      );
      return ok(true as const);
    });
  } catch (error) {
    if (isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
