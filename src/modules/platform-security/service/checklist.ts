import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { type Clock, realClock } from '@/modules/clock';
import { BOOTSTRAP_ACTOR_ID, SYSTEM_ACTOR_ID } from '../auth/actors';
import { auditDenied } from '../auth/guards';
import type { SessionUser } from '../auth/session-gate';
import {
  CHECKLIST,
  type ChecklistItem,
  type ChecklistKey,
  computeChecklist,
  type ManualMark,
} from '../domain/checklist';
import { can } from '../domain/permissions';
import { ForbiddenError } from './user-admin';

export interface ChecklistDeps {
  /** The app runtime environment, to check it holds no backup credentials (default: process.env). */
  runtimeEnv?: Record<string, string | undefined>;
  /** belgobeton_system: reads the checklist tables under the system actor. */
  systemPool: pg.Pool;
  /** belgobeton_auth: account facts (2FA enrolment, seed accounts). */
  authPool: pg.Pool;
  clock: Clock;
}

export type Checklist = { items: ChecklistItem[]; complete: boolean };

const asSystem = <T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(pool, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: uuidv7(realClock.now()) }, fn);

export async function getChecklist({
  systemPool,
  authPool,
  clock,
  runtimeEnv,
}: ChecklistDeps): Promise<Checklist> {
  const { manual, lastRestoreTestOk } = await asSystem(systemPool, async (tx) => {
    const marks = await tx.query<{
      key: string;
      status: 'open' | 'done';
      evidence: string;
      checked_at: Date;
      checked_by: string;
    }>('select key, status, evidence, checked_at, checked_by::text from security_checklist_item');
    const run = await tx.query<{ at: Date | null }>(
      `select max(at) as at from security_check_run where key = 'restore_test' and ok`,
    );
    return {
      manual: Object.fromEntries(
        marks.rows.map((m): [string, ManualMark] => [
          m.key,
          { status: m.status, evidence: m.evidence, checkedAt: m.checked_at, checkedBy: m.checked_by },
        ]),
      ),
      lastRestoreTestOk: run.rows[0]?.at ?? null,
    };
  });
  const { rows } = await authPool.query<{ without2fa: number; seed: number }>(
    `select count(*) filter (where not coalesce("twoFactorEnabled", false))::int as without2fa,
            count(*) filter (where role <> 'owner' and "createdBy" = $1)::int as seed
       from "user" where status = 'active'`,
    [BOOTSTRAP_ACTOR_ID],
  );
  return computeChecklist(
    {
      manual,
      lastRestoreTestOk,
      usersWithout2fa: rows[0]!.without2fa,
      seedAccounts: rows[0]!.seed,
      appHasBackupCredentials: !!(runtimeEnv ?? process.env).DATABASE_URL_BACKUP,
    },
    clock.now(),
  );
}

/** Owner marks a manual item done with evidence (audited by the capture trigger). The sign-off comes last. */
export async function markChecklistItem(
  appPool: pg.Pool,
  actor: SessionUser,
  key: ChecklistKey,
  evidence: string,
  deps: ChecklistDeps,
): Promise<void> {
  if (!can(actor.role, 'checklist.manage')) {
    await auditDenied(appPool, actor, 'checklist.manage');
    throw new ForbiddenError();
  }
  if (!Object.hasOwn(CHECKLIST, key)) throw new Error('Unknown checklist item');
  if (CHECKLIST[key].kind === 'automated') throw new Error('Automated items cannot be marked by hand');
  const text = evidence.trim();
  if (!text || text.length > 2000) throw new Error('Evidence is required (at most 2000 characters)');
  if (key === 'owner_signoff') {
    const open = (await getChecklist(deps)).items.filter(
      (i) => i.key !== 'owner_signoff' && i.status === 'open',
    );
    if (open.length) throw new Error(`Cannot sign off: ${open.length} item(s) still open`);
  }

  const now = deps.clock.now();
  await withRlsContext(appPool, { userId: actor.id, role: actor.role, requestId: uuidv7(now) }, (tx) =>
    tx.query(
      `insert into security_checklist_item (key, status, evidence, checked_by, checked_at) values ($1, 'done', $2, $3, $4)
       on conflict (key) do update set status = 'done', evidence = excluded.evidence,
         checked_by = excluded.checked_by, checked_at = excluded.checked_at`,
      [key, text, actor.id, now],
    ),
  );
}

/** Records a restore-test result (scripts/restore-test.ts) as automated evidence, under the system actor. */
export async function recordRestoreTest(
  systemPool: pg.Pool,
  result: { ok: boolean; detail: string },
): Promise<void> {
  await asSystem(systemPool, (tx) =>
    tx.query(`insert into security_check_run (key, ok, at, detail) values ('restore_test', $1, $2, $3)`, [
      result.ok,
      realClock.now(),
      result.detail.slice(0, 500),
    ]),
  );
}

/** Boot guard (SPEC §8): REAL_DATA=true is refused until the checklist is complete. */
export async function assertRealDataAllowed(
  realData: boolean,
  getList: () => Promise<Checklist>,
): Promise<void> {
  if (!realData) return;
  const checklist = await getList();
  if (!checklist.complete) {
    const open = checklist.items.filter((i) => i.status === 'open').map((i) => i.key);
    throw new Error(
      `REAL_DATA=true refused: the security checklist is incomplete (${open.join(', ') || 'unknown'})`,
    );
  }
}
