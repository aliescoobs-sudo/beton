import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  answerSurvey,
  closeSurvey,
  createSurvey,
  flagAnomaly,
  getAnomalyReport,
  getSurveyResults,
  listMySurveys,
  listSurveys,
} from '../src/modules/assistant';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { deliveryScene, insertDelivery } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// R10 (CP-PROD-PLAN, REQUIREMENTS-V1 §11): deterministic reports and field surveys. No model, no amount.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await Promise.all([app.end(), system.end()]);
});
const marker = `ad${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const u = {} as Record<string, SessionUser>;
const refused = async (p: Promise<unknown>) => {
  try {
    const r = (await p) as { ok?: boolean } | boolean | null;
    return r === false || r === null || (typeof r === 'object' && r !== null && r.ok === false);
  } catch {
    return true;
  }
};

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  u.owner = v.owner;
  for (const r of ['app_admin', 'office_sales', 'plant_manager', 'accountant', 'support'] as const)
    u[r] = v.session(r);
});

describe('the anomaly report', () => {
  it('counts failed jobs and BLs not returned in the window, flags by a fixed rule, and is read by owner, app_admin and support only', async () => {
    const day = `2031-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`;
    await withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: marker }, (tx) =>
      tx.query(
        `insert into scheduled_job_run (id, job_key, business_date, status, ran_at, run_by, error) values (gen_random_uuid(), $1, $2, 'failed', now(), $3, 'boom')`,
        [`ad-${marker.slice(2, 8)}`, day, SYSTEM_ACTOR_ID],
      ),
    );
    const scene = await withRlsContext(
      app,
      { userId: u.owner!.id, role: 'owner', requestId: marker },
      async (tx) => {
        await tx.query(`select set_config('app.plant_id', $1, true)`, [
          (await tx.query<{ id: string }>(`select id from plant where status = 'active' limit 1`)).rows[0]
            ?.id ?? '',
        ]);
        return deliveryScene(app, u.owner!.id, marker);
      },
    );
    await withRlsContext(app, { userId: u.owner!.id, role: 'owner', requestId: marker }, async (tx) => {
      await tx.query(
        `select set_config('app.plant_id', coalesce((select id::text from plant where status = 'active' limit 1), ''), true)`,
      );
      await insertDelivery(tx, u.owner!.id, scene, 1000);
    });
    const r = await getAnomalyReport(
      app,
      u.owner!,
      { from: '2026-05-30', to: '2026-06-02' },
      { now: new Date('2026-06-10T09:00:00Z') },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value.find((x) => x.kind === 'bl_not_returned')!.n).toBeGreaterThanOrEqual(1);
    const jobs = await getAnomalyReport(
      app,
      u.app_admin!,
      { from: day, to: day },
      { now: new Date(`${day}T20:00:00Z`) },
    );
    if (!jobs.ok) throw new Error(jobs.error);
    expect(jobs.value.find((x) => x.kind === 'job_failed')).toMatchObject({ n: 1, flagged: true });
    expect(
      await getAnomalyReport(app, u.support!, { from: day, to: day }, { now: new Date() }),
    ).toMatchObject({ ok: true });
    for (const who of ['office_sales', 'plant_manager', 'accountant'])
      expect(
        await refused(getAnomalyReport(app, u[who]!, { from: day, to: day }, { now: new Date() })),
        who,
      ).toBe(true);
    expect(
      await refused(
        getAnomalyReport(app, u.owner!, { from: '2026-01-01', to: '2026-12-31' }, { now: new Date() }),
      ),
    ).toBe(true);
  });
  it('the thresholds are a fixed rule', () => {
    expect(flagAnomaly('job_failed', 1)).toBe(true);
    expect(flagAnomaly('late_cancellation', 2)).toBe(false);
    expect(flagAnomaly('late_cancellation', 3)).toBe(true);
  });
});

describe('field surveys', () => {
  const questions = [
    { id: 'q1', text: 'Do you print the BL from the app?', kind: 'yes_no' as const },
    { id: 'q2', text: 'How easy is the order screen?', kind: 'scale' as const },
    { id: 'q3', text: 'What slows you down?', kind: 'text' as const },
  ];
  let id = '';
  it('the owner creates one for a role; only that role sees it, once', async () => {
    expect(
      await refused(createSurvey(app, u.office_sales!, { audience: 'office_sales', title: 'x', questions })),
    ).toBe(true);
    const made = await createSurvey(app, u.app_admin!, {
      audience: 'office_sales',
      title: `Sales ${marker}`,
      questions,
    });
    if (!made.ok) throw new Error(made.error);
    id = made.value.id;
    expect((await listMySurveys(app, u.office_sales!)).some((s) => s.id === id)).toBe(true);
    expect((await listMySurveys(app, u.plant_manager!)).some((s) => s.id === id)).toBe(false);
    expect(await refused(createSurvey(app, u.owner!, { audience: 'owner', title: 'x', questions }))).toBe(
      true,
    );
    expect(
      await refused(
        createSurvey(app, u.owner!, {
          audience: 'driver',
          title: 'x',
          questions: [{ id: 'Bad Id', text: 'x', kind: 'text' }],
        }),
      ),
    ).toBe(true);
  });
  it('answers are checked against the questions, once per person, and only by the audience', async () => {
    expect(await refused(answerSurvey(app, u.plant_manager!, id, { q1: true }))).toBe(true);
    expect(await refused(answerSurvey(app, u.office_sales!, id, { q1: 'yes' }))).toBe(true);
    expect(await refused(answerSurvey(app, u.office_sales!, id, { q2: 7 }))).toBe(true);
    expect(
      (await answerSurvey(app, u.office_sales!, id, { q1: true, q2: 4, q3: 'too many clicks' })).ok,
    ).toBe(true);
    expect(await refused(answerSurvey(app, u.office_sales!, id, { q1: false }))).toBe(true);
    expect((await listMySurveys(app, u.office_sales!)).some((s) => s.id === id)).toBe(false);
  });
  it('the results go to owner and app_admin as counts and texts, with no respondent, and nobody else reads them', async () => {
    const r = await getSurveyResults(app, u.owner!, id);
    expect(r).toMatchObject({ responses: 1, audience: 'office_sales' });
    const byId = Object.fromEntries(r!.questions.map((q) => [q.id, q.answers]));
    expect(byId.q1).toEqual({ true: 1 });
    expect(byId.q2).toEqual({ '4': 1 });
    expect(byId.q3).toEqual(['too many clicks']);
    expect(JSON.stringify(r)).not.toContain(u.office_sales!.id);
    expect((await listSurveys(app, u.app_admin!)).find((s) => s.id === id)?.responses).toBe(1);
    for (const who of ['office_sales', 'plant_manager', 'accountant'])
      expect(await refused(getSurveyResults(app, u[who]!, id)), who).toBe(true);
  });
  it('a closed survey takes no more answers', async () => {
    const made = await createSurvey(app, u.owner!, {
      audience: 'plant_manager',
      title: `Plant ${marker}`,
      questions,
    });
    if (!made.ok) throw new Error(made.error);
    expect(await closeSurvey(app, u.owner!, made.value.id)).toBe(true);
    expect(await refused(answerSurvey(app, u.plant_manager!, made.value.id, { q1: true }))).toBe(true);
  });
});
