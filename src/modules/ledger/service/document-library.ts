import type pg from 'pg';
import { z } from 'zod';
import {
  can,
  DOCUMENT_KINDS,
  type DocumentKind,
  inRequest,
  isMalformedId,
  recordAuditEvent,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { groupInvoiceLines, netToPay } from '../domain/invoice-groups';
import type { InvoiceDocument } from './invoice-service';

// §16.2: one library, filtered by role and by document type. A list shows only the types the role may open; a download
// re-checks the permission and reads through the caller's own row-level security (or the reviewed print door), then audits.

export interface LibraryEntry {
  kind: DocumentKind;
  id: string;
  number: string;
  date: string;
  party: string | null;
}

/** office_sales and the old office role print invoices through the print door; everybody else reads the table by RLS. */
const printsThroughDoor = (role: string) => role === 'office_sales' || role === 'office';

const SQL: Record<DocumentKind, (role: string) => string> = {
  invoice: (role) =>
    printsThroughDoor(role)
      ? `select id, number, to_char(invoice_date, 'YYYY-MM-DD') as date, client_name as party from public.invoice_print_index()`
      : `select id, number, to_char(invoice_date, 'YYYY-MM-DD') as date, client_name as party from invoice order by invoice_date desc, number desc limit 500`,
  avoir: () =>
    `select a.id, a.number, to_char(a.avoir_date, 'YYYY-MM-DD') as date, c.name as party from avoir a join client c on c.id = a.client_id order by a.avoir_date desc, a.number desc limit 500`,
  quote: () =>
    `select q.id, q.code as number, to_char(q.quote_date, 'YYYY-MM-DD') as date, c.name as party from quote q join client c on c.id = q.client_id order by q.quote_date desc, q.code desc limit 500`,
  bl: () =>
    `select id, bl_no as number, to_char(load_date, 'YYYY-MM-DD') as date, null::text as party from delivery order by load_date desc, bl_no desc limit 500`,
  supplier_invoice_file: () =>
    `select f.supplier_invoice_id::text || ':' || f.id::text as id, s.code || '-' || f.seq as number, to_char(f.created_at, 'YYYY-MM-DD') as date, null::text as party
       from supplier_invoice_file f join supplier_invoice s on s.id = f.supplier_invoice_id order by f.created_at desc limit 500`,
};

/** The kinds this role may open. */
export function libraryKinds(role: SessionUser['role']): DocumentKind[] {
  return (Object.keys(DOCUMENT_KINDS) as DocumentKind[]).filter((k) => can(role, DOCUMENT_KINDS[k]));
}

export async function listDocumentLibrary(
  appPool: pg.Pool,
  actor: SessionUser,
  kind?: DocumentKind,
): Promise<LibraryEntry[]> {
  await require(appPool, actor, 'documents.read');
  const kinds = libraryKinds(actor.role).filter((k) => !kind || k === kind);
  const out: LibraryEntry[] = [];
  await inRequest(appPool, actor, async (tx) => {
    for (const k of kinds) {
      const { rows } = await tx.query<Omit<LibraryEntry, 'kind'>>(SQL[k](actor.role));
      out.push(...rows.map((r) => ({ ...r, kind: k })));
    }
  });
  return out;
}

/**
 * The permission check of one download, repeated server-side (never trusted from the list). Returns false when the role
 * may not open this type; the route answers 404. Every successful open is audited by the route.
 */
export function mayOpen(role: SessionUser['role'], kind: DocumentKind): boolean {
  return can(role, DOCUMENT_KINDS[kind]);
}

interface PrintRow {
  id: string;
  number: string;
  client_id: string;
  client_name: string;
  client_ice: string | null;
  invoice_date: string;
  issue_deadline: string;
  due_date: string;
  vat_rate_bp: number;
  total_ht_centimes: string;
  total_vat_centimes: string;
  total_ttc_centimes: string;
  credit_note_of: string | null;
  credit_note_of_number: string | null;
  reason: string | null;
  order_codes: string[];
  advance_centimes: string;
  lines: {
    seq: number;
    description: string;
    volume_l: number;
    price: string | number;
    total: string | number;
    bl_no: string;
    type_code: string;
    type_label: string;
  }[];
}

const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/**
 * The invoice as office_sales prints it (§3.3): the document with its amounts, for one invoice, with no payment state and
 * no balance. It is the same shape as the owner's document, so the same PDF is drawn; the payment fields stay empty.
 */
export async function getInvoiceForPrint(
  appPool: pg.Pool,
  actor: SessionUser,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  await require(appPool, actor, 'documents.invoice');
  if (!z.uuid().safeParse(invoiceId).success) return null;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<PrintRow>(`select * from public.invoice_print($1)`, [invoiceId]),
    );
    const r = rows[0];
    if (!r) return null;
    const lines = r.lines.map((l) => ({
      seq: l.seq,
      description: l.description,
      volumeL: l.volume_l,
      unitPriceHtCentimes: Number(l.price),
      lineHtCentimes: Number(l.total),
    }));
    const advanceCentimes = Number(r.advance_centimes);
    const totalTtc = Number(r.total_ttc_centimes);
    const dayMs = 86_400_000;
    return {
      invoice: {
        id: r.id,
        number: r.number,
        orderCodes: r.order_codes,
        clientId: r.client_id,
        clientName: r.client_name,
        clientIce: r.client_ice,
        invoiceDate: ymd(r.invoice_date),
        issueDeadline: ymd(r.issue_deadline),
        dueDate: ymd(r.due_date),
        vatRateBp: r.vat_rate_bp,
        totalHtCentimes: Number(r.total_ht_centimes),
        totalVatCentimes: Number(r.total_vat_centimes),
        totalTtcCentimes: totalTtc,
        creditNoteOf: r.credit_note_of,
        cancelled: false,
        reason: r.reason,
        paymentState: null,
        paidCentimes: 0,
      },
      creditNoteOfNumber: r.credit_note_of_number,
      termDays: Math.round((Date.parse(ymd(r.due_date)) - Date.parse(ymd(r.invoice_date))) / dayMs),
      groups: groupInvoiceLines(
        r.lines.map((l) => ({
          blNo: l.bl_no,
          typeCode: l.type_code,
          typeLabel: l.type_label,
          volumeL: l.volume_l,
          unitPriceHtCentimes: Number(l.price),
          lineHtCentimes: Number(l.total),
        })),
      ),
      advanceCentimes,
      netToPayCentimes: netToPay(totalTtc, advanceCentimes),
      lines,
    };
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}

export async function recordLibraryOpen(appPool: pg.Pool, actor: SessionUser, what: string): Promise<void> {
  await inRequest(appPool, actor, (tx) =>
    recordAuditEvent(tx, { action: 'export', table: `library:${what}` }),
  );
}
