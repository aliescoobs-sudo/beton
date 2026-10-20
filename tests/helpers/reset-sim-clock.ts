import pg from 'pg';
import { superuserUrl, TEST_DATABASE } from '../../scripts/db-bootstrap';
import { testEnv } from '../db-env';

/** Removes the sim_clock singleton. Test-only, as superuser: runtime roles have no DELETE on it. */
export async function resetSimClock(): Promise<void> {
  const superuser = new pg.Client({ connectionString: superuserUrl(testEnv(), TEST_DATABASE) });
  await superuser.connect();
  try {
    await superuser.query('delete from sim_clock');
  } finally {
    await superuser.end();
  }
}
