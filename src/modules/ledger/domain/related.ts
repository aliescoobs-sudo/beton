/** The kinds of document a page can point to from another (SPEC-integration §4, I3.2). */
export const RELATED_KINDS = [
  'quote',
  'order',
  'trip',
  'bl',
  'invoice',
  'avoir',
  'purchase',
  'receipt',
  'supplier_invoice',
  'payment',
] as const;
export type RelatedKind = (typeof RELATED_KINDS)[number];

export interface RelatedDocument {
  kind: RelatedKind;
  /** The printed number, or a short label where the document has none (a receipt: its date). */
  code: string;
  /** The page that opens it, without the locale; null when this caller cannot open it: the number is then shown, not linked. */
  path: string | null;
}

/** Keeps the first of each kind and code (a payment that covers two plan items is one payment). */
export function uniqueRelated(items: readonly RelatedDocument[]): RelatedDocument[] {
  const seen = new Set<string>();
  const out: RelatedDocument[] = [];
  for (const i of items) {
    const key = `${i.kind}\u0000${i.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out.sort(
    (a, b) => RELATED_KINDS.indexOf(a.kind) - RELATED_KINDS.indexOf(b.kind) || a.code.localeCompare(b.code),
  );
}
