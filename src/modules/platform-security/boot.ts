import { getPool } from '@/lib/db/pools';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { getEnv } from '@/lib/server-env';
import { trainingBootProblem } from '@/lib/training';
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

/**
 * Node-only, first at start (T1): the training flag and the database must agree. Refuses a database that holds the training seed when
 * TRAINING_MODE is not on, and TRAINING_MODE next to APP_ENV=production.
 */
export async function assertTrainingGuardOrExit(): Promise<void> {
  try {
    const env = getEnv();
    const { rows } = await getPool('system').query<{ seeded: boolean }>(
      'select public.training_seeded() as seeded',
    );
    const problem = trainingBootProblem({
      trainingMode: env.TRAINING_MODE,
      appEnv: env.APP_ENV,
      databaseSeeded: rows[0]?.seeded === true,
    });
    if (problem) throw new Error(problem);
    if (env.TRAINING_MODE)
      console.warn('TRAINING_MODE: fictitious data only. Imports and outbound integrations are off.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
