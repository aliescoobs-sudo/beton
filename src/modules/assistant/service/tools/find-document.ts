import { z } from 'zod';
import { searchDocuments } from '@/modules/ledger';
import type { AssistantTool } from '../../domain/tool-types';

const KINDS = [
  'bl',
  'order',
  'invoice',
  'quote',
  'purchase',
  'supplier_invoice',
  'avoir',
  'payment',
] as const;

const out = z.object({
  count: z.number().int(),
  documents: z.array(
    z.object({
      kind: z.enum(KINDS),
      // Null for a payment: the number of a cheque or an LCN is an instrument number and is never in a payload.
      number: z.string().nullable(),
      /** Whether the caller's role has a screen for it; no address, no id. */
      openable: z.boolean(),
    }),
  ),
});

/**
 * Finds documents by their number through the search service of the search box (AC-ASSIST-22): the same rule (four characters at
 * least, only what a document number is made of, exact or prefix), the same row-level security, the same audited misses and the
 * same lock-out after ten of them. There is no search by name, here as there. A payment is found by its number and returned
 * without it: instrument numbers are never sent to a model.
 */
export const findDocument: AssistantTool = {
  name: 'find_document',
  kind: 'read',
  description:
    'Finds documents (BL, order, invoice, avoir, quote, purchase order, supplier invoice, payment) by their number, exact or the first characters (four at least). Cannot search by name.',
  params: z.object({ number: z.string().min(1).max(40) }).strict(),
  roles: ['owner', 'partner', 'office', 'plant', 'support'],
  permissions: ['search.number'],
  output: () => out,
  async run(ctx, args) {
    const { number } = args as { number: string };
    const found = await searchDocuments(ctx.appPool, ctx.actor, number);
    if (!found.ok) {
      // A lock-out or a rate limit is a refusal, not a bad argument.
      if (found.error === 'TOO_MANY_ATTEMPTS' || found.error === 'RATE_LIMITED') return { error: 'LOCKED' };
      return { error: found.error };
    }
    const documents = found.value.slice(0, 20).map((d) => ({
      kind: d.kind,
      number: d.kind === 'payment' ? null : d.code,
      openable: d.path !== null,
    }));
    return { count: found.value.length, documents };
  },
};
