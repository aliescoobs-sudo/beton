import { createHash } from 'node:crypto';

// What an apply is confirmed against (Extra 1 and R14-11). One digest covers the WHOLE decision: the full sha256 of the file, the mappings
// in force and the opening date. The person types it in full; the verified second-factor code is bound to the same string (`operation`),
// and the importer recomputes it from what it is about to apply and refuses a proof that names another one.

/** JSON with sorted keys: the same value always gives the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function importConfirmation(input: {
  fileSha256: string;
  mappings: unknown;
  openingDate: string | null;
}): { digest: string; phrase: string; operation: string } {
  const digest = createHash('sha256')
    .update(
      stableJson({ v: 1, file: input.fileSha256, mappings: input.mappings, openingDate: input.openingDate }),
    )
    .digest('hex');
  return { digest, phrase: `IMPORT ${digest}`, operation: `import:${digest}` };
}

/** The rollback phrase carries the WHOLE run id (a UUID), not its last twelve characters. */
export const rollbackConfirmation = (runId: string): { phrase: string; operation: string } => ({
  phrase: `ROLLBACK ${runId}`,
  operation: `rollback:${runId}`,
});

/** A verified second-factor code, bound to the account that gave it and to ONE operation (the strings above). */
export interface StepUpProof {
  userId: string;
  operation: string;
}
