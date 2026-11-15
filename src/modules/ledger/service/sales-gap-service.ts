import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * T19 item 4 (ADMIN-GAP A4, A5): the client PO number and the commercial of an order, the client aliases and the two per-client flags.
 * Every rule is in the doors of migration 0247; this file only calls them.
 */
export type SalesGapError = 'INVALID' | 'NOT_ALLOWED' | 'REFUSED';

export interface OrderExtra {
  orderId: string;
  clientPo: string | null;
  commercial: string | null;
}

/** The PO and the commercial of these orders (the BL and the invoice show the PO of their order). Empty when none was entered. */
export async function listOrderExtras(
  appPool: pg.Pool,
  actor: SessionUser,
  orderIds: string[],
): Promise<Map<string, OrderExtra>> {
  if (orderIds.length === 0) return new Map();
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ o_order_id: string; o_client_po: string | null; o_commercial: string | null }>(
      'select * from public.order_extras($1::uuid[])',
      [orderIds],
    ),
  );
  return new Map(
    rows.map(
      (r) =>
        [
          r.o_order_id,
          { orderId: r.o_order_id, clientPo: r.o_client_po, commercial: r.o_commercial },
        ] as const,
    ),
  );
}

export interface ClientAlias {
  id: string;
  clientId: string;
  clientCode: string;
  alias: string;
}

export async function listClientAliases(
  appPool: pg.Pool,
  actor: SessionUser,
  clientId: string | null = null,
): Promise<ClientAlias[]> {
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ o_id: string; o_client_id: string; o_client_code: string; o_alias: string }>(
      'select * from public.client_alias_list($1::uuid)',
      [clientId],
    ),
  );
  return rows.map((r) => ({
    id: r.o_id,
    clientId: r.o_client_id,
    clientCode: r.o_client_code,
    alias: r.o_alias,
  }));
}

async function run<T>(
  appPool: pg.Pool,
  actor: SessionUser,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<Result<T, SalesGapError>> {
  try {
    return ok(await inRequest(appPool, actor, fn));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') return err<SalesGapError>('NOT_ALLOWED');
    if (code === '23514' || code === '23505' || code === '23503') return err<SalesGapError>('REFUSED');
    throw error;
  }
}

export async function addClientAlias(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  await require(appPool, actor, 'parties.write');
  const p = z.object({ clientId: z.uuid(), alias: z.string().trim().min(2).max(120) }).safeParse(input);
  if (!p.success) return err<SalesGapError>('INVALID');
  return run(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('select public.add_client_alias($1, $2) as id', [
      p.data.clientId,
      p.data.alias,
    ]);
    return { id: rows[0]!.id };
  });
}

/** The client's terms: its purchase-order number is mandatory on every order, and how its prices are agreed (HT or TTC). */
export async function setClientTerms(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  if (!can(actor.role, 'client_terms.write')) await require(appPool, actor, 'client_terms.write');
  const p = z
    .object({ clientId: z.uuid(), poRequired: z.boolean(), priceBasis: z.enum(['HT', 'TTC']) })
    .safeParse(input);
  if (!p.success) return err<SalesGapError>('INVALID');
  return run(appPool, actor, async (tx) => {
    await tx.query('select public.set_client_terms($1, $2, $3)', [
      p.data.clientId,
      p.data.poRequired,
      p.data.priceBasis,
    ]);
    return true as const;
  });
}

export interface ClientTerms {
  poRequired: boolean;
  priceBasis: 'HT' | 'TTC';
}

export async function getClientTerms(
  appPool: pg.Pool,
  actor: SessionUser,
  clientId: string,
): Promise<ClientTerms | null> {
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ po_required: boolean; price_basis: 'HT' | 'TTC' }>(
      'select po_required, price_basis from client where id = $1',
      [clientId],
    ),
  );
  return rows[0] ? { poRequired: rows[0].po_required, priceBasis: rows[0].price_basis } : null;
}

/** The ids of the clients that require their purchase-order number on every order (the order form says so before the person saves). */
export async function listPoRequiredClientIds(appPool: pg.Pool, actor: SessionUser): Promise<string[]> {
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ id: string }>('select id from client where po_required'),
  );
  return rows.map((r) => r.id);
}
