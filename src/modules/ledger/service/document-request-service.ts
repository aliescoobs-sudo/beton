import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';

// R7 (REQUIREMENTS-V1 §9, §12): the gate every number-bearing document a client asks for must pass, the timing of the final invoice and the
// continuation of the invoice numbering. Reviewed database doors; a request holds no amount.

export type DocumentRequestError =
  'INVALID' | 'NOT_FOUND' | 'ALREADY_WAITING' | 'NOT_AVAILABLE' | 'FORBIDDEN';
export const DOCUMENT_REQUEST_KINDS = [
  'releve',
  'invoice_copy',
  'quote_copy',
  'avoir_copy',
  'bl_copy',
  'supplier_statement',
] as const;
export type DocumentRequestKind = (typeof DOCUMENT_REQUEST_KINDS)[number];
export const INVOICE_TIMINGS = ['full_payment', 'monthly', 'per_delivery'] as const;
export type InvoiceTiming = (typeof INVOICE_TIMINGS)[number];

export interface MyDocumentRequest {
  id: string;
  kind: DocumentRequestKind;
  partyKind: 'client' | 'supplier';
  partyCode: string;
  docRef: string | null;
  status: 'pending' | 'approved' | 'denied' | 'used' | 'expired';
  createdAt: string;
}
export interface PendingDocumentRequest {
  id: string;
  requesterName: string;
  kind: DocumentRequestKind;
  partyKind: 'client' | 'supplier';
  partyCode: string;
  docRef: string | null;
  note: string | null;
  createdAt: string;
}

function failure(error: unknown): DocumentRequestError {
  const e = error as { code?: string };
  if (e.code === '23505') return 'ALREADY_WAITING';
  if (e.code === '42501') return 'FORBIDDEN';
  if (e.code === '23514' || isMalformedId(error)) return 'INVALID';
  throw error;
}

const requestInput = z.object({
  kind: z.enum(DOCUMENT_REQUEST_KINDS),
  partyKind: z.enum(['client', 'supplier']),
  partyCode: z.string().trim().min(1).max(40),
  docRef: z.string().trim().min(1).max(40).nullish(),
  note: z.string().trim().max(300).nullish(),
});

export async function requestDocument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, DocumentRequestError>> {
  await require(appPool, actor, 'documents.request');
  const p = requestInput.safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.request_document($1, $2, $3, $4, $5) as id', [
        p.data.kind,
        p.data.partyKind,
        p.data.partyCode,
        p.data.docRef ?? null,
        p.data.note ?? null,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    return err(failure(error));
  }
}

export async function listMyDocumentRequests(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<MyDocumentRequest[]> {
  await require(appPool, actor, 'documents.request');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query('select * from public.my_document_requests()'),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    partyKind: r.party_kind,
    partyCode: r.party_code,
    docRef: r.doc_ref,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function listPendingDocumentRequests(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<PendingDocumentRequest[]> {
  await require(appPool, actor, 'approvals.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query('select * from public.document_requests_pending()'),
  );
  return rows.map((r) => ({
    id: r.id,
    requesterName: r.requester_name,
    kind: r.kind,
    partyKind: r.party_kind,
    partyCode: r.party_code,
    docRef: r.doc_ref,
    note: r.note,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Owner or app_admin approves or denies (the caller requires a fresh second factor). Nobody decides their own request. */
export async function decideDocumentRequest(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<true, DocumentRequestError>> {
  await require(appPool, actor, 'documents.decide');
  const p = z.object({ id: z.uuid(), approve: z.boolean() }).safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.decide_document_request($1, $2)', [p.data.id, p.data.approve]),
    );
    return ok(true);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23514') return err('NOT_AVAILABLE');
    return err(failure(error));
  }
}

/** The kind of request that lets a client copy of each document type go out (F08). */
export const COPY_REQUEST_KIND = {
  invoice: 'invoice_copy',
  avoir: 'avoir_copy',
  quote: 'quote_copy',
  bl: 'bl_copy',
} as const;

/**
 * F08: the download of a client copy. Checks and consumes, in one statement under a row lock, an approved request that is the
 * caller's own, for this kind and this document number, for a document of the requested client, at most 24 hours old, once.
 */
export async function consumeDocumentCopy(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { requestId: string; kind: keyof typeof COPY_REQUEST_KIND; docRef: string },
): Promise<boolean> {
  await require(appPool, actor, 'documents.request');
  if (!z.uuid().safeParse(input.requestId).success) return false;
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.consume_document_copy($1, $2, $3)', [
        input.requestId,
        COPY_REQUEST_KIND[input.kind],
        input.docRef,
      ]),
    );
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '42501') return false;
    throw error;
  }
}

/** The release of an approved statement (relevé) to the requester, once. A document copy goes out by its download only. */
export async function releaseDocumentRequest(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
): Promise<
  Result<{ kind: DocumentRequestKind; partyCode: string; docRef: string | null }, DocumentRequestError>
> {
  await require(appPool, actor, 'documents.request');
  if (!z.uuid().safeParse(id).success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query('select * from public.use_document_request($1)', [id]),
    );
    const r = rows[0];
    return r ? ok({ kind: r.kind, partyCode: r.party_code, docRef: r.doc_ref }) : err('NOT_AVAILABLE');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') return err('NOT_AVAILABLE');
    return err(failure(error));
  }
}

export async function getInvoiceTiming(appPool: pg.Pool, actor: SessionUser): Promise<InvoiceTiming> {
  await require(appPool, actor, 'documents.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ t: InvoiceTiming }>('select public.invoice_timing() as t'),
  );
  return rows[0]?.t ?? 'per_delivery';
}

export async function setInvoiceTiming(
  appPool: pg.Pool,
  actor: SessionUser,
  timing: unknown,
): Promise<Result<true, DocumentRequestError>> {
  await require(appPool, actor, 'documents.policy');
  const p = z.enum(INVOICE_TIMINGS).safeParse(timing);
  if (!p.success) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) => tx.query('select public.set_invoice_timing($1)', [p.data]));
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

/** The company's last invoice number of the year: the next invoice is last + 1. Forward only. */
export async function setInvoiceSequence(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { year: number; last: number },
): Promise<Result<true, DocumentRequestError>> {
  await require(appPool, actor, 'documents.sequence');
  const p = z
    .object({ year: z.number().int().min(2000).max(2999), last: z.number().int().min(1).max(99_999_999) })
    .safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.set_invoice_sequence($1, $2)', [p.data.year, p.data.last]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}
