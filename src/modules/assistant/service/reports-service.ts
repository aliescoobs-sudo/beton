import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { ANOMALY_KINDS, type AnomalyKind, type AnomalyRow, flagAnomaly } from '../domain/anomaly';

// R10 (REQUIREMENTS-V1 §11): the deterministic reports and the field surveys. Database functions only; no model, no amount.

export type ReportError = 'INVALID' | 'NOT_FOUND' | 'NOT_AVAILABLE' | 'ALREADY_ANSWERED';

function failure(error: unknown): ReportError {
  const e = error as { code?: string };
  if (e.code === '23505') return 'ALREADY_ANSWERED';
  if (e.code === '42501') return 'NOT_AVAILABLE';
  if (e.code === '23514' || isMalformedId(error)) return 'INVALID';
  throw error;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Application and operations anomalies over a window (at most 92 days): counts, a few codes, and whether the rule flags them. */
export async function getAnomalyReport(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { from: string; to: string },
  deps: { now: Date },
): Promise<Result<AnomalyRow[], ReportError>> {
  await require(appPool, actor, 'reports.anomalies');
  if (!day.safeParse(input.from).success || !day.safeParse(input.to).success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ kind: AnomalyKind; n: number; refs: string[] }>(
        'select * from public.anomaly_report($1::date, $2::date, $3::timestamptz)',
        [input.from, input.to, deps.now.toISOString()],
      ),
    );
    return ok(
      ANOMALY_KINDS.map((kind) => {
        const r = rows.find((x) => x.kind === kind);
        const n = r?.n ?? 0;
        return { kind, n, refs: r?.refs ?? [], flagged: flagAnomaly(kind, n) };
      }),
    );
  } catch (error) {
    return err(failure(error));
  }
}

export interface SurveyQuestion {
  id: string;
  text: string;
  kind: 'yes_no' | 'scale' | 'text';
}
const questionsInput = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z0-9_]{1,20}$/),
      text: z.string().trim().min(1).max(200),
      kind: z.enum(['yes_no', 'scale', 'text']),
    }),
  )
  .min(1)
  .max(10);
export const SURVEY_AUDIENCES = [
  'office_sales',
  'office_purchases',
  'office',
  'plant_manager',
  'plant',
  'driver',
  'pump_operator',
  'accountant',
] as const;

export async function createSurvey(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { audience: string; title: string; questions: unknown },
): Promise<Result<{ id: string }, ReportError>> {
  await require(appPool, actor, 'surveys.manage');
  const p = z
    .object({
      audience: z.enum(SURVEY_AUDIENCES),
      title: z.string().trim().min(1).max(120),
      questions: questionsInput,
    })
    .safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.create_survey($1, $2, $3::jsonb) as id', [
        p.data.audience,
        p.data.title,
        JSON.stringify(p.data.questions),
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    return err(failure(error));
  }
}

export async function closeSurvey(appPool: pg.Pool, actor: SessionUser, id: string): Promise<boolean> {
  await require(appPool, actor, 'surveys.manage');
  if (!z.uuid().safeParse(id).success) return false;
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ ok: boolean }>('select public.close_survey($1) as ok', [id]),
  );
  return rows[0]?.ok ?? false;
}

export interface OpenSurvey {
  id: string;
  title: string;
  questions: SurveyQuestion[];
}
/** The surveys waiting for the caller's role that the caller has not answered. */
export async function listMySurveys(appPool: pg.Pool, actor: SessionUser): Promise<OpenSurvey[]> {
  await require(appPool, actor, 'surveys.answer');
  const { rows } = await inRequest(appPool, actor, (tx) => tx.query('select * from public.my_surveys()'));
  return rows.map((r) => ({ id: r.id, title: r.title, questions: r.questions }));
}

export async function answerSurvey(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
  answers: Record<string, boolean | number | string>,
): Promise<Result<true, ReportError>> {
  await require(appPool, actor, 'surveys.answer');
  if (!z.uuid().safeParse(id).success) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.answer_survey($1, $2::jsonb)', [id, JSON.stringify(answers)]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

export interface SurveySummary {
  id: string;
  title: string;
  audience: string;
  status: 'open' | 'closed';
  responses: number;
  createdAt: string;
}
export async function listSurveys(appPool: pg.Pool, actor: SessionUser): Promise<SurveySummary[]> {
  await require(appPool, actor, 'surveys.results');
  const { rows } = await inRequest(appPool, actor, (tx) => tx.query('select * from public.surveys_list()'));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    audience: r.audience_role,
    status: r.status,
    responses: r.responses,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export interface SurveyResults {
  title: string;
  audience: string;
  status: string;
  responses: number;
  questions: {
    id: string;
    text: string;
    kind: SurveyQuestion['kind'];
    answers: Record<string, number> | string[];
  }[];
}
export async function getSurveyResults(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
): Promise<SurveyResults | null> {
  await require(appPool, actor, 'surveys.results');
  if (!z.uuid().safeParse(id).success) return null;
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ r: SurveyResults | null }>('select public.survey_results($1) as r', [id]),
  );
  return rows[0]?.r ?? null;
}
