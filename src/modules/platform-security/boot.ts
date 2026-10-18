import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { realClock } from '@/modules/clock';
import { assertRealDataAllowed, getChecklist } from './service/checklist';

/** Node-only: REAL_DATA=true with an incomplete security checklist stops the server (SPEC §8, D37). */
export async function assertRealDataOrExit(): Promise<void> {
  try {
    await assertRealDataAllowed(getEnv().REAL_DATA, () =>
      getChecklist({ systemPool: getPool('system'), authPool: getPool('auth'), clock: realClock }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
