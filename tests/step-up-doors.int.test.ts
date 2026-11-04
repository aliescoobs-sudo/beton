import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  cancelUnproducedOrder,
  decideCancellation,
  getCancellationPolicy,
  setCancellationPolicy,
} from '../src/modules/operations';
import { inRequest } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// D3 / F03: the decisions of §8 and the forced close of a day are refused by the database without the step-up mark, whatever reached
// them. The mark is carried for one transaction only and is never left on a pooled connection.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 }); // one connection: a mark that stuck would be seen
const marker = `su${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let owner: SessionUser;
beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
});
afterAll(() => app.end());

const as = <T>(stepUp: boolean, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker, stepUp }, fn);
const SECOND_FACTOR = /fresh second factor/;

describe('the database doors that need a fresh second factor (F03)', () => {
  it('refuse a decision, a policy change, the reversal of an unproduced order and a forced close without the mark', async () => {
    const id = randomUUID();
    await expect(
      as(false, (tx) =>
        tx.query(
          `select public.decide_cancellation($1, 'loss', null, null, 1, null, null, null, false, now())`,
          [id],
        ),
      ),
    ).rejects.toThrow(SECOND_FACTOR);
    await expect(
      as(false, (tx) => tx.query(`select public.set_cancellation_policy(true, false)`)),
    ).rejects.toThrow(SECOND_FACTOR);
    await expect(
      as(false, (tx) => tx.query(`select public.cancel_unproduced_order($1, 'x', current_date)`, [id])),
    ).rejects.toThrow(SECOND_FACTOR);
    await expect(
      as(false, (tx) => tx.query(`select public.close_day($1, current_date, true, 'forced')`, [id])),
    ).rejects.toThrow(SECOND_FACTOR);
  });

  it('pass the mark check with it (they then fail on what they are about, not on the second factor)', async () => {
    const id = randomUUID();
    const decided = await as(true, (tx) =>
      tx.query(
        `select public.decide_cancellation($1, 'loss', null, null, 1, null, null, null, false, now()) as r`,
        [id],
      ),
    );
    expect(decided.rows[0].r).toBe(false); // unknown case
    await expect(
      as(true, (tx) => tx.query(`select public.cancel_unproduced_order($1, 'x', current_date)`, [id])),
    ).rejects.not.toThrow(SECOND_FACTOR);
    await expect(
      as(true, (tx) => tx.query(`select public.close_day($1, current_date, true, 'forced')`, [id])),
    ).rejects.not.toThrow(SECOND_FACTOR);
  });

  it('a plain close (not forced) never asks for it, and the mark does not stay on the connection', async () => {
    await expect(
      as(false, (tx) => tx.query(`select public.close_day($1, current_date, false, null)`, [randomUUID()])),
    ).rejects.not.toThrow(SECOND_FACTOR);
    // same single connection: a request without the mark right after one with it is still refused
    await as(true, (tx) => tx.query(`select 1`));
    await expect(
      as(false, (tx) => tx.query(`select public.set_cancellation_policy(true, false)`)),
    ).rejects.toThrow(SECOND_FACTOR);
  });

  it('the services carry the mark of a stepped-up user and not of a plain one', async () => {
    const plain = owner;
    const stepped = { ...owner, stepUpVerified: true };
    expect(
      await setCancellationPolicy(app, plain, { plantMayDecide: false, clientCharged: false }),
    ).toMatchObject({ ok: false });
    expect(
      await setCancellationPolicy(app, stepped, { plantMayDecide: false, clientCharged: false }),
    ).toMatchObject({ ok: true });
    expect(await getCancellationPolicy(app, plain)).toMatchObject({ plantMayDecide: false });
    expect(
      await decideCancellation(app, plain, { caseId: randomUUID(), decision: 'loss' }, { now: new Date() }),
    ).toMatchObject({ ok: false });
    expect(
      await cancelUnproducedOrder(app, plain, { orderId: randomUUID() }, { today: '2026-06-02' }),
    ).toMatchObject({ ok: false });
    // inRequest marks the transaction from the user
    const seen = await inRequest(app, stepped, (tx) =>
      tx.query(`select current_setting('app.step_up', true) as v`),
    );
    expect(seen.rows[0].v).toBe('verified');
    const notSeen = await inRequest(app, plain, (tx) =>
      tx.query(`select current_setting('app.step_up', true) as v`),
    );
    expect(notSeen.rows[0].v).toBe('');
  });
});
