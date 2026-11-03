'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { parseQuestions } from './questions';
import { getEnv } from '@/lib/server-env';
import {
  answerSurvey,
  closeSurvey,
  createSurvey,
  SURVEY_AUDIENCES,
  type SurveyQuestion,
} from '@/modules/assistant';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

const deps = () => ({ getState: currentAuthState, appPool: getPool('app') });

// @permission surveys.manage (owner, app_admin): creates a short questionnaire for one role
export async function createSurveyAction(formData: FormData): Promise<void> {
  if (!getEnv().ASSISTANT_DET_ENABLED) return;
  const allowed = await authorize('surveys.manage', deps());
  if (!allowed.ok) return;
  const audience = String(formData.get('audience'));
  if (!(SURVEY_AUDIENCES as readonly string[]).includes(audience)) return;
  await createSurvey(getPool('app'), allowed.user, {
    audience,
    title: String(formData.get('title') ?? ''),
    questions: parseQuestions(String(formData.get('questions') ?? '')),
  });
  revalidatePath('/', 'layout');
}

// @permission surveys.manage (owner, app_admin): closes a survey
export async function closeSurveyAction(formData: FormData): Promise<void> {
  if (!getEnv().ASSISTANT_DET_ENABLED) return;
  const allowed = await authorize('surveys.manage', deps());
  if (!allowed.ok) return;
  await closeSurvey(getPool('app'), allowed.user, String(formData.get('id')));
  revalidatePath('/', 'layout');
}

// @permission surveys.answer (the audience roles): answers a survey addressed to the caller's role, once
export async function answerSurveyAction(formData: FormData): Promise<void> {
  if (!getEnv().ASSISTANT_DET_ENABLED) return;
  const allowed = await authorize('surveys.answer', deps());
  if (!allowed.ok) return;
  const answers: Record<string, boolean | number | string> = {};
  for (const [key, value] of formData.entries()) {
    if (!/^q\d{1,2}$/.test(key) || typeof value !== 'string' || value === '') continue;
    const kind = String(formData.get(`kind_${key}`));
    answers[key] = kind === 'yes_no' ? value === 'yes' : kind === 'scale' ? Number(value) : value;
  }
  await answerSurvey(getPool('app'), allowed.user, String(formData.get('id')), answers);
  revalidatePath('/', 'layout');
}
