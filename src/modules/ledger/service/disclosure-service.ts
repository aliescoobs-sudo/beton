import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';

// §16.3 (REQUIREMENTS-V1 §11, §16.3): figure disclosure. The request, the decision and the view are three reviewed database
// doors. The scope is a person, a data item (with its document) and a duration; the default is one view within 15 minutes.

export type DisclosureError = 'INVALID' | 'NOT_FOUND' | 'ALREADY_WAITING' | 'NOT_AVAILABLE';
export const DISCLOSURE_KINDS = ['order_total', 'invoice_total', 'client_balance'] as const;
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number];

export interface MyDisclosure {
  id: string;
  itemKind: DisclosureKind;
  itemRef: string;
  status: 'pending' | 'approved' | 'denied';
  mode: 'single_view' | 'window' | null;
  expiresAt: string | null;
  /** Views still allowed (null: any number until it expires). */
  viewsLeft: number | null;
  createdAt: string;
}
export interface PendingDisclosure {
  id: string;
  requesterName: string;
  itemKind: DisclosureKind;
  itemRef: string;
  documentKind: string | null;
  reason: string | null;
  createdAt: string;
}
export interface DisclosedFigure {
  itemKind: DisclosureKind;
  itemRef: string;
  centimes: number;
  viewsLeft: number | null;
  expiresAt: string;
}

const requestInput = z.object({
  kind: z.enum(DISCLOSURE_KINDS),
  ref: z.string().trim().min(1).max(40),
  documentKind: z.enum(['order', 'invoice', 'quote', 'statement']).nullish(),
  documentRef: z.string().trim().min(1).max(40).nullish(),
  reason: z.string().trim().max(300).nullish(),
});

export async function requestDisclosure(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, DisclosureError>> {
  await require(appPool, actor, 'disclosure.request');
  const p = requestInput.safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.request_disclosure($1, $2, $3, $4, $5) as id', [
        p.data.kind,
        p.data.ref,
        p.data.documentKind ?? null,
        p.data.documentRef ?? null,
        p.data.reason ?? null,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') return err('ALREADY_WAITING');
    if (code === '23514') return err('NOT_FOUND');
    throw error;
  }
}

export async function listMyDisclosures(appPool: pg.Pool, actor: SessionUser): Promise<MyDisclosure[]> {
  await require(appPool, actor, 'disclosure.request');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      item_kind: DisclosureKind;
      item_ref: string;
      status: MyDisclosure['status'];
      mode: MyDisclosure['mode'];
      expires_at: Date | null;
      views_left: number | null;
      created_at: Date;
    }>('select * from public.my_disclosures()'),
  );
  return rows.map((r) => ({
    id: r.id,
    itemKind: r.item_kind,
    itemRef: r.item_ref,
    status: r.status,
    mode: r.mode,
    expiresAt: r.expires_at?.toISOString() ?? null,
    viewsLeft: r.views_left,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function listPendingDisclosures(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<PendingDisclosure[]> {
  await require(appPool, actor, 'approvals.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      requester_name: string;
      item_kind: DisclosureKind;
      item_ref: string;
      document_kind: string | null;
      reason: string | null;
      created_at: Date;
    }>('select * from public.disclosures_pending()'),
  );
  return rows.map((r) => ({
    id: r.id,
    requesterName: r.requester_name,
    itemKind: r.item_kind,
    itemRef: r.item_ref,
    documentKind: r.document_kind,
    reason: r.reason,
    createdAt: r.created_at.toISOString(),
  }));
}

const decideInput = z.object({
  id: z.uuid(),
  approve: z.boolean(),
  mode: z.enum(['single_view', 'window']).default('single_view'),
  minutes: z.number().int().min(1).max(60).default(15),
});

/** The owner or app_admin approves (default: one view, 15 minutes) or denies. A fresh second factor is required by the caller. */
export async function decideDisclosure(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<true, DisclosureError>> {
  await require(appPool, actor, 'disclosure.decide');
  const p = decideInput.safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.decide_disclosure($1, $2, $3, $4)', [
        p.data.id,
        p.data.approve,
        p.data.mode,
        p.data.minutes,
      ]),
    );
    return ok(true);
  } catch (error) {
    if ((error as { code?: string }).code === '23514' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

/** The figure, to the person it was approved for, once per allowed view. Every view is audited by the database. */
export async function viewDisclosure(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
): Promise<Result<DisclosedFigure, DisclosureError>> {
  await require(appPool, actor, 'disclosure.request');
  if (!z.uuid().safeParse(id).success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{
        item_kind: DisclosureKind;
        item_ref: string;
        centimes: string;
        views_left: number | null;
        expires_at: Date;
      }>('select * from public.view_disclosure($1)', [id]),
    );
    const r = rows[0]!;
    return ok({
      itemKind: r.item_kind,
      itemRef: r.item_ref,
      centimes: Number(r.centimes),
      viewsLeft: r.views_left,
      expiresAt: r.expires_at.toISOString(),
    });
  } catch (error) {
    if ((error as { code?: string }).code === '42501') return err('NOT_AVAILABLE');
    throw error;
  }
}
