import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getEngineParams } from '@/app/engine-params';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listMoneyAccounts } from '@/modules/ledger';
import { AlertReport } from '@/modules/owner-dashboard';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { loadDashboard } from '@/modules/rules-engine';
import { buttonClass, PageHeader } from '@/ui';
import { applyOptionAction, reclassifyAction } from '../actions';

/** The report of one alert: causes, ranked options with their computed coverage and what-if forecast, and the actions. */
export default async function AlertPage({ params }: { params: Promise<{ locale: string; key: string }> }) {
  const { locale, key } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'cash.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:alert-report');
  const today = (await getRequestClock()).today();
  const view = await loadDashboard(pool, user, { today, params: await getEngineParams() });
  const wanted = decodeURIComponent(key);
  const alert = view.alerts.find((a) => a.key === wanted);
  const t = await getTranslations('dashboard');
  if (!alert) {
    return (
      <div>
        <PageHeader title={t('report.title')} />
        <p role="status" data-testid="alert-gone">
          {t('report.notFound')}
        </p>
        {(view.decisions[wanted] ?? []).length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-xl">{t('report.decisionsTitle')}</h2>
            <ul data-testid="report-decisions">
              {(view.decisions[wanted] ?? []).map((d) => (
                <li key={d.id} className="row-item space-y-1 text-sm">
                  <p className="font-semibold">{d.kinds.map((k) => t(`option.kinds.${k}`)).join(' + ')}</p>
                  {d.draftText && <pre className="whitespace-pre-wrap text-muted">{d.draftText}</pre>}
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="mt-4">
          <Link href={`/${locale}`} className={buttonClass('secondary')}>
            {t('report.back')}
          </Link>
        </p>
      </div>
    );
  }
  const banks = (await listMoneyAccounts(pool, user))
    .filter((a) => a.kind === 'bank')
    .map((a) => ({ id: a.id, label: a.label }));
  return (
    <div>
      <PageHeader
        title={t('report.title')}
        actions={
          <Link href={`/${locale}`} className={buttonClass('secondary')}>
            {t('report.back')}
          </Link>
        }
      />
      <AlertReport
        view={view}
        alert={alert}
        locale={locale}
        banks={banks}
        actions={{ apply: applyOptionAction, reclassify: reclassifyAction }}
      />
    </div>
  );
}
