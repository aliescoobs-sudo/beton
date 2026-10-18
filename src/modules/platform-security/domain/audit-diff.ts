export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Fields whose value differs between the before and after images of an audit event, sorted by name. */
export function auditDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldChange[] {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return fields
    .filter((f) => JSON.stringify(before?.[f]) !== JSON.stringify(after?.[f]))
    .map((field) => ({ field, before: before?.[field], after: after?.[field] }));
}
