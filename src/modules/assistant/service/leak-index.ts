import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { SYSTEM_ACTOR_ID } from '@/modules/platform-security';
import type { LeakIndex } from '../domain/leak-scan';
import type { PayloadCipher } from './cipher';

const TTL_MS = 30_000;
let cache: { at: number; index: LeakIndex } | undefined;

/**
 * Every name and number the leak scan looks for (SPEC-assistant §4), read as the system actor through one reviewed function
 * (migration 0077), with the sealed phones and addresses opened here. Kept in this process's memory for thirty seconds: the
 * mapping lives in memory only and is never written anywhere. A string the database holds that cannot be opened is skipped,
 * and a failure to read at all is an error, never an empty index: a turn without its leak check does not go out.
 */
export async function loadLeakIndex(
  systemPool: pg.Pool,
  cipher: PayloadCipher,
  now: number = realClock.now().getTime(),
): Promise<LeakIndex> {
  if (cache && now - cache.at < TTL_MS) return cache.index;
  const rows = await withRlsContext(
    systemPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: uuidv7(realClock.now()) },
    async (tx) =>
      (
        await tx.query<{ kind: string; value: string }>(
          'select kind, value from public.assistant_leak_index()',
        )
      ).rows,
  );
  const names = new Set<string>();
  const numbers = new Set<string>();
  for (const { kind, value } of rows) {
    if (kind === 'name') names.add(value);
    else if (kind === 'number') numbers.add(value);
    else {
      try {
        const plain = cipher.open(value);
        // A sealed phone is digits; a sealed address is words: the scan treats each as what it is.
        if (/\d{6,}/.test(plain.replace(/[\s.-]/g, ''))) numbers.add(plain);
        else names.add(plain);
      } catch {
        continue;
      }
    }
  }
  const index = { names: [...names], numbers: [...numbers] };
  cache = { at: now, index };
  return index;
}

/** For tests: forget what was read. */
export const forgetLeakIndex = (): void => {
  cache = undefined;
};
