import pg from 'pg';
import { superuserUrl, TEST_DATABASE } from '../../scripts/db-bootstrap';
import { testEnv } from '../db-env';

// T10f group 3E: unique codes WITHOUT chance. A driver code is `CH-` and two to four digits and a truck code a letter and one to three: small spaces that many suites
// used to draw from at random, so two suites (or two draws of one) sometimes met on the same code and failed on a unique violation. The allocator draws a candidate
// and asks the database (as the superuser, which sees every row whatever the row-level security says) until it is FREE. The integration project runs its files one after
// the other, so the free code cannot be taken between the question and the insert.
async function free(table: 'driver' | 'truck', candidate: () => string): Promise<string> {
  const c = new pg.Client({ connectionString: superuserUrl(testEnv(), TEST_DATABASE) });
  await c.connect();
  try {
    for (let i = 0; i < 500; i++) {
      const code = candidate();
      const taken = await c.query(`select 1 from ${table} where code = $1`, [code]);
      if (!taken.rowCount) return code;
    }
    throw new Error(`no free ${table} code`);
  } finally {
    await c.end();
  }
}

/** A driver code (`CH-` + 4 digits) that no driver has. */
export const freeDriverCode = (): Promise<string> =>
  free('driver', () => `CH-${1000 + Math.floor(Math.random() * 9000)}`);
/** A truck code (T, P or X + 3 digits) that no truck has. */
export const freeTruckCode = (prefix: 'T' | 'P' | 'X' = 'T'): Promise<string> =>
  free('truck', () => `${prefix}${100 + Math.floor(Math.random() * 900)}`);
