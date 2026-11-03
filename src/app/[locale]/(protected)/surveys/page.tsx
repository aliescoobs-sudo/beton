import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import {
  getSurveyResults,
  listMySurveys,
  listSurveys,
  SURVEY_AUDIENCES,
  type SurveyResults,
} from '@/modules/assistant';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, PageHeader } from '@/ui';
import { answerSurveyAction, closeSurveyAction, createSurveyAction } from './actions';

/** Field surveys (R10, §11): the owner asks a role a few questions about what it does in the app; the role answers; results come back as counts. */
export default async function SurveysPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().ASSISTANT_DET_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'surveys.read');
  const pool = getPool('app');
  const t = await getTranslations('surveys');
  const mine = can(user.role, 'surveys.answer') ? await listMySurveys(pool, user) : [];
  const all = can(user.role, 'surveys.results') ? await listSurveys(pool, user) : [];
  const results = new Map<string, SurveyResults | null>();
  for (const s of all) results.set(s.id, await getSurveyResults(pool, user, s.id));
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {mine.map((s) => (
        <form
          key={s.id}
          action={answerSurveyAction}
          className="mt-4 space-y-2 rounded border p-3"
          data-testid={`survey-${s.id}`}
        >
          <input type="hidden" name="id" value={s.id} />
          <h2 className="font-semibold">{s.title}</h2>
          {s.questions.map((q) => (
            <label key={q.id} className="block text-sm">
              {q.text}
              <input type="hidden" name={`kind_${q.id}`} value={q.kind} />
              {q.kind === 'yes_no' && (
                <select name={q.id} className="ms-2" defaultValue="">
                  <option value="">—</option>
                  <option value="yes">{t('yes')}</option>
                  <option value="no">{t('no')}</option>
                </select>
              )}
              {q.kind === 'scale' && (
                <input name={q.id} type="number" min={1} max={5} className="ms-2 w-16" />
              )}
              {q.kind === 'text' && <input name={q.id} maxLength={500} className="ms-2 w-80" />}
            </label>
          ))}
          <Button type="submit">{t('send')}</Button>
        </form>
      ))}
      {can(user.role, 'surveys.manage') && (
        <form action={createSurveyAction} className="mt-6 space-y-2 text-sm" data-testid="survey-create">
          <h2 className="text-lg font-semibold">{t('create')}</h2>
          <input name="title" placeholder={t('titleField')} required className="w-80" />
          <select name="audience">
            {SURVEY_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <textarea
            name="questions"
            rows={4}
            required
            placeholder={t('questionsHint')}
            className="block w-full max-w-xl"
          />
          <Button type="submit">{t('createButton')}</Button>
        </form>
      )}
      <ul className="mt-6 space-y-3">
        {all.map((s) => (
          <li key={s.id} className="rounded border p-3 text-sm" data-testid={`result-${s.id}`}>
            <strong>{s.title}</strong> · {s.audience} · {t(`status.${s.status}` as never)} ·{' '}
            {t('responses', { count: s.responses })}
            {results.get(s.id)?.questions.map((q) => (
              <p key={q.id}>
                {q.text}: {Array.isArray(q.answers) ? q.answers.join(' | ') : JSON.stringify(q.answers)}
              </p>
            ))}
            {can(user.role, 'surveys.manage') && s.status === 'open' && (
              <form action={closeSurveyAction}>
                <input type="hidden" name="id" value={s.id} />
                <Button type="submit">{t('close')}</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
