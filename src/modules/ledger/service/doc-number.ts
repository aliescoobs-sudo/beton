import type pg from 'pg';
import { type DocPrefix, DOC_NUMBER_WIDTH, docYearOf } from '../domain/doc-number';

/**
 * The next CMD-/ACH-/FA- number of the business date's year. Call it inside the transaction that creates the document:
 * the counter row stays locked until that transaction ends, and a rollback gives the number back (gapless).
 */
export async function nextDocNumber(
  tx: pg.PoolClient,
  prefix: DocPrefix,
  businessDate: string,
): Promise<string> {
  const { rows } = await tx.query<{ n: string }>('select public.next_doc_number($1, $2, $3) as n', [
    prefix,
    docYearOf(businessDate),
    DOC_NUMBER_WIDTH,
  ]);
  return rows[0]?.n as string;
}
