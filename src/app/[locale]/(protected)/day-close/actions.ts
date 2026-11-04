'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { closeDay } from '@/modules/operations';
import { authorize, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

export type CloseDayResult = { ok: true; value: string } | { ok: false; error: string };

// @permission dayclose.write (owner, app_admin, plant_manager): closes the day of a plant; blocking items stop it and tell the owner, who can
// close it knowingly with a note. A forced close is the sensitive action dayclose.force: it needs a fresh second factor (F03), here and in the database.
export async function closeDayAction(input: {
  plantId: string;
  date: string;
  force?: boolean;
  note?: string;
}): Promise<CloseDayResult> {
  if (!getEnv().TRANSFERS_ENABLED) return { ok: false, error: 'NOT_FOUND' };
  const allowed = await authorize('dayclose.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const run = async (user: typeof allowed.user) => {
    const r = await closeDay(getPool('app'), user, {
      plantId: String(input.plantId),
      date: String(input.date),
      force: input.force === true,
      note: input.note ? String(input.note) : undefined,
    });
    revalidatePath('/', 'layout');
    return r;
  };
  const result =
    input.force === true
      ? await (async () => {
          const guarded = await withStepUp('dayclose.force', run, { getState: currentAuthState });
          return guarded.ok ? guarded.value : { ok: false as const, error: guarded.error };
        })()
      : await run(allowed.user);
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
}
