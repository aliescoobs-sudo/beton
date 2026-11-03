import { getPool } from '@/lib/db/pools';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { getEnv } from '@/lib/server-env';
import { realClock } from '@/modules/clock';
import { SYSTEM_ACTOR_ID } from './auth/actors';
import { getChecklist, resolveStartMode } from './service/checklist';

/**
 * Node-only: REAL_DATA=true with an incomplete security checklist stops the server (SPEC §8, D37), except in the protected first
 * start (FIRST_BOOT, C2). A restore test older than 35 days does not stop a server that is already running: the checklist screen
 * and the monthly routine show it; only "never restored" does.
 */
export async function assertRealDataOrExit(): Promise<void> {
  try {
    const env = getEnv();
    const mode = await resolveStartMode({
      realData: env.REAL_DATA,
      firstBoot: env.FIRST_BOOT,
      getList: () =>
        getChecklist({
          systemPool: getPool('system'),
          authPool: getPool('auth'),
          clock: realClock,
          restoreMaxAgeMs: Number.POSITIVE_INFINITY,
        }),
      countRecords: () =>
        withRlsContext(
          getPool('system'),
          { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: uuidv7(realClock.now()) },
          async (tx) =>
            Number(
              (await tx.query<{ n: string }>('select public.first_boot_record_count() as n')).rows[0]?.n ?? 0,
            ),
        ),
    });
    if (mode === 'first_boot')
      console.warn(
        'FIRST_BOOT: restricted mode. Only sign-in, enrolment, the checklist, accounts, plants and parameters are served.',
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
