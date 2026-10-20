import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { businessDateOf } from '../domain/business-date';
import { type Clock, realClock } from './clock';

/** The clock a request sees: real time, or a snapshot of `sim_now` taken once for that request. */
export type RequestClock = Clock & { readonly simulated: boolean };

export class SimulationDisabledError extends Error {
  constructor() {
    super('Simulation is disabled');
    this.name = 'SimulationDisabledError';
  }
}

/** Actors allowed to write the simulated clock; the database policy only admits owner and system. */
export interface SimClockActor {
  userId: string;
  role: 'owner' | 'system';
}

const real: RequestClock = { now: realClock.now, today: realClock.today, simulated: false };

function snapshotClock(at: Date): RequestClock {
  return { now: () => new Date(at), today: () => businessDateOf(at), simulated: true };
}

/**
 * Clock for one request. With simulation disabled the table is never read (AC-CLK-01); enabled, `sim_now` is read
 * once and frozen for the request, so one request never sees two different "now".
 */
export async function loadRequestClock(
  readerPool: pg.Pool,
  simulationEnabled: boolean,
): Promise<RequestClock> {
  if (!simulationEnabled) return real;
  const { rows } = await readerPool.query<{ sim_now: Date }>(
    `select sim_now from sim_clock where mode = 'simulated'`,
  );
  return rows[0] ? snapshotClock(rows[0].sim_now) : real;
}

/** Current `sim_now`, read as `actor`. Throws when simulation is disabled (AC-CLK-01) or the clock is not initialised. */
export async function readSimNow(
  pool: pg.Pool,
  simulationEnabled: boolean,
  actor: SimClockActor,
): Promise<Date> {
  if (!simulationEnabled) throw new SimulationDisabledError();
  const rows = await withRlsContext(
    pool,
    { userId: actor.userId, role: actor.role, requestId: uuidv7(new Date()) },
    async (tx) =>
      (await tx.query<{ sim_now: Date }>(`select sim_now from sim_clock where mode = 'simulated'`)).rows,
  );
  if (!rows[0]) throw new Error('Simulated clock is not initialised');
  return rows[0].sim_now;
}

/**
 * Boot: bring the singleton in line with SIMULATION_ENABLED. Enabling creates it (or resumes it, never earlier than
 * its stored instant); disabling flips an existing row back to 'real'. Runs as the system actor, audited.
 */
export async function syncSimClock(
  systemPool: pg.Pool,
  simulationEnabled: boolean,
  actorId: string,
  now: Date,
): Promise<void> {
  const ctx = { userId: actorId, role: 'system' as const, requestId: uuidv7(now) };
  await withRlsContext(systemPool, ctx, async (tx) => {
    if (simulationEnabled) {
      await tx.query(
        `insert into sim_clock (mode, sim_now, updated_by, updated_at) values ('simulated', $1, $2, $1)
         on conflict (id) do update set mode = 'simulated', sim_now = greatest(sim_clock.sim_now, excluded.sim_now),
           updated_by = excluded.updated_by, updated_at = excluded.updated_at
         where sim_clock.mode <> 'simulated'`,
        [now, actorId],
      );
    } else {
      await tx.query(
        `update sim_clock set mode = 'real', updated_by = $1, updated_at = $2 where mode = 'simulated'`,
        [actorId, now],
      );
    }
  });
}

/**
 * Moves `sim_now` forward. The service refuses when simulation is disabled (AC-CLK-01) or the target is not later
 * than the current instant (AC-CLK-05, the database trigger enforces the same rule). Authorization (owner + step-up)
 * belongs to the caller in `src/app`; `advance` (T24) builds on this.
 */
export async function setSimNow(
  pool: pg.Pool,
  simulationEnabled: boolean,
  actor: SimClockActor,
  to: Date,
  now: Date,
): Promise<void> {
  if (!simulationEnabled) throw new SimulationDisabledError();
  await withRlsContext(
    pool,
    { userId: actor.userId, role: actor.role, requestId: uuidv7(now) },
    async (tx) => {
      const { rows } = await tx.query<{ sim_now: Date }>(
        `select sim_now from sim_clock where mode = 'simulated' for update`,
      );
      if (!rows[0]) throw new Error('Simulated clock is not initialised');
      if (to.getTime() <= rows[0].sim_now.getTime()) throw new Error('sim_now can only move forward');
      await tx.query(`update sim_clock set sim_now = $1, updated_by = $2, updated_at = $3`, [
        to,
        actor.userId,
        now,
      ]);
    },
  );
}
