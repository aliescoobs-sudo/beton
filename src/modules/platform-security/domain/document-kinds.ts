import type { Permission } from './permissions';

/**
 * §16.2: the document types of the library and the permission each one needs. The library lists only the types a role
 * may open, and every download checks the same permission again, then reads through the caller's own row-level security.
 */
export const DOCUMENT_KINDS = {
  invoice: 'documents.invoice',
  avoir: 'avoirs.read',
  quote: 'quotes.read',
  bl: 'deliveries.read',
  supplier_invoice_file: 'supplier_invoices.read',
} as const satisfies Record<string, Permission>;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;
export const isDocumentKind = (v: string): v is DocumentKind => Object.hasOwn(DOCUMENT_KINDS, v);
