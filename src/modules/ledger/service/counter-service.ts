import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * Document counters (T19 item 3, D246): numbering continues from the last number of the paper or Excel series. Owner and app_admin
 * (`opening.write`; the doors check the actor again). A counter only moves forward: a number already issued is never reused.
 */
export const COUNTER_PREFIXES = ['CMD', 'BL', 'ACH', 'FA'] as const;
export type CounterPrefix = (typeof COUNTER_PREFIXES)[number];
export type CounterError = 'INVALID' | 'NOT_FORWARD';

const schema = z.object({
  prefix: z.enum(COUNTER_PREFIXES),
  year: z.number().int().min(2000).max(2999),
  last: z.number().int().min(1).max(99_999_999),
});

export async function getDocCounter(
  appPool: pg.Pool,
  actor: SessionUser,
  prefix: CounterPrefix,
  year: number,
): Promise<number | null> {
  await require(appPool, actor, 'opening.write');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ n: number | null }>('select public.get_doc_counter($1, $2) as n', [prefix, year]),
  );
  return rows[0]?.n ?? null;
}

export async function setDocCounter(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ last: number }, CounterError>> {
  await require(appPool, actor, 'opening.write');
  const p = schema.safeParse(input);
  if (!p.success) return err<CounterError>('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.set_doc_counter($1, $2, $3)', [p.data.prefix, p.data.year, p.data.last]),
    );
    return ok({ last: p.data.last });
  } catch (error) {
    if ((error as { code?: string }).code === '23514') return err<CounterError>('NOT_FORWARD');
    throw error;
  }
}
