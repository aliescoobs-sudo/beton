import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { getAnomalyReport } from '@/modules/assistant';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader, StatusPill } from '@/ui';

/** What the application and the operations did badly in the last 14 days: counts of recorded facts against fixed thresholds (R10, §11). */
export default async function AnomaliesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().ASSISTANT_DET_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'reports.anomalies');
  const now = (await getRequestClock()).now();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const report = await getAnomalyReport(getPool('app'), user, { from, to }, { now });
  const t = await getTranslations('anomalies');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro', { from, to })} />
      <ul className="mt-4 space-y-2" data-testid="anomalies">
        {report.ok &&
          report.value.map((r) => (
            <li
              key={r.kind}
              className="flex flex-wrap items-center gap-3 rounded border p-3"
              data-testid={`anomaly-${r.kind}`}
            >
              <StatusPill status={r.flagged ? 'late' : 'paid'}>
                {r.flagged ? t('flagged') : t('ok')}
              </StatusPill>
              <span className="font-medium">{t(`kind.${r.kind}` as never)}</span>
              <span>{r.n}</span>
              {r.refs.length > 0 && <span className="text-sm text-muted">{r.refs.join(', ')}</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}
