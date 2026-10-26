import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { realClock } from '@/modules/clock';
import {
  can,
  inRequest,
  recordAuditEvent,
  require,
  type Role,
  type SessionUser,
} from '@/modules/platform-security';
import { type RelatedDocument, type RelatedKind, uniqueRelated } from '../domain/related';
import { normalizeSearchQuery, type SearchQueryError, SearchRateLimiter } from '../domain/search';

export type SearchError = SearchQueryError | 'RATE_LIMITED' | 'TOO_MANY_ATTEMPTS';

const limiter = new SearchRateLimiter(30, 60_000);

/** Ten unknown probes in ten minutes lock an actor out of the search, as for the office doors (D84). */
const LOCKOUT_MISSES = 10;

function pathFor(role: Role, kind: RelatedKind, id: string): string | null {
  switch (kind) {
    case 'bl':
      return can(role, 'deliveries.read') ? `/deliveries/${id}` : null;
    case 'order':
      return can(role, 'orders.read_money') ? `/orders/${id}` : null;
    case 'invoice':
      return can(role, 'invoices.read') ? `/invoices/${id}` : null;
    case 'quote':
      return can(role, 'quotes.read') ? `/quotes/${id}` : null;
    case 'purchase':
      return can(role, 'purchases.read_money') ? `/purchases/${id}` : null;
    case 'supplier_invoice':
      return can(role, 'supplier_invoices.read') ? `/supplier-invoices/${id}` : null;
    case 'avoir':
      return can(role, 'avoirs.read') ? '/avoirs' : null;
    case 'payment':
      return can(role, 'instruments.read') ? '/instruments' : null;
    default:
      return null;
  }
}

const SOURCES: { kind: RelatedKind; sql: string }[] = [
  {
    kind: 'bl',
    sql: `select id, bl_no as code from delivery where bl_no like $1 || '%' order by bl_no limit 10`,
  },
  // The operational view, so the plant and the partner find an order by its number and office (which has no read) finds none.
  {
    kind: 'order',
    sql: `select id, code from sales_order_ops where code like $1 || '%' and reverses_id is null order by code limit 10`,
  },
  {
    kind: 'invoice',
    sql: `select id, number as code from invoice where number like $1 || '%' order by number limit 10`,
  },
  {
    kind: 'avoir',
    sql: `select id, number as code from avoir where number like $1 || '%' order by number limit 10`,
  },
  { kind: 'quote', sql: `select id, code from quote where code like $1 || '%' order by code limit 10` },
  {
    kind: 'purchase',
    sql: `select distinct purchase_id as id, code from purchase_line_ops where code like $1 || '%' order by code limit 10`,
  },
  {
    kind: 'supplier_invoice',
    sql: `select id, code from supplier_invoice where code like $1 || '%' or upper(supplier_invoice_no) like $1 || '%' order by code limit 10`,
  },
  {
    kind: 'payment',
    sql: `select id, number as code from payment_instrument where number is not null and upper(number) like $1 || '%' order by number limit 10`,
  },
];

/**
 * Finds documents by their number, exact or prefix, four characters at least (AC-INT-18). What comes back is what the caller's
 * own row-level security lets it read: a role that reads no money finds no invoice or payment, office finds BLs only. There is
 * no search on names: the query must look like a document number. A search that finds nothing is audited, and ten of them in ten
 * minutes lock the actor out; searches are also rate-limited per actor. A result is a link only where the caller can open it.
 */
export async function searchDocuments(
  appPool: pg.Pool,
  actor: SessionUser,
  raw: string,
  deps: { now?: number; limiter?: SearchRateLimiter } = {},
): Promise<Result<RelatedDocument[], SearchError>> {
  await require(appPool, actor, 'search.number');
  const q = normalizeSearchQuery(raw);
  if (!q.ok) return err(q.error);
  if (!(deps.limiter ?? limiter).take(actor.id, deps.now ?? realClock.now().getTime()))
    return err('RATE_LIMITED');
  return inRequest(appPool, actor, async (tx): Promise<Result<RelatedDocument[], SearchError>> => {
    const misses = await tx.query<{ n: string }>(
      `select count(*)::text as n from audit_event
        where actor_user_id = $1 and table_name = 'document_search' and action = 'permission_denied'
          and at > clock_timestamp() - interval '10 minutes'`,
      [actor.id],
    );
    if (Number(misses.rows[0]?.n ?? 0) >= LOCKOUT_MISSES) return err('TOO_MANY_ATTEMPTS');
    const found: RelatedDocument[] = [];
    for (const source of SOURCES) {
      const { rows } = await tx.query<{ id: string; code: string }>(source.sql, [q.value]);
      for (const r of rows)
        found.push({ kind: source.kind, code: r.code, path: pathFor(actor.role, source.kind, r.id) });
    }
    if (found.length === 0)
      await recordAuditEvent(tx, { action: 'permission_denied', table: 'document_search', reason: q.value });
    return ok(uniqueRelated(found));
  });
}
