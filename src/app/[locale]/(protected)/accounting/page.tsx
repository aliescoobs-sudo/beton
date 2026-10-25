import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { buildAccountingExport, EXPORT_FILES } from '@/modules/ledger';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Card, Money, PageHeader } from '@/ui';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The accountant's files for a period: four CSV downloads, with the check that the journals tie out. Owner and support. */
export default async function AccountingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'accounting.export');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:accounting');
  const today = (await getRequestClock()).today();
  const q = await searchParams;
  const from = q.from && DATE.test(q.from) ? q.from : `${today.slice(0, 8)}01`;
  const to = q.to && DATE.test(q.to) ? q.to : today;
  const result = await buildAccountingExport(pool, user, { from, to });
  const t = await getTranslations('ledger.accounting');
  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} description={t('intro')} />
      <form method="get" className="form-band flex flex-wrap items-end gap-3" data-testid="accounting-period">
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <input
            name="from"
            type="date"
            dir="ltr"
            defaultValue={from}
            className="input mt-1"
            data-testid="accounting-from"
          />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <input
            name="to"
            type="date"
            dir="ltr"
            defaultValue={to}
            className="input mt-1"
            data-testid="accounting-to"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" data-testid="accounting-apply">
          {t('apply')}
        </button>
      </form>
      {!result.ok ? (
        <p role="alert" className="field-error" data-testid="accounting-error">
          {t(`errors.${result.error}`)}
        </p>
      ) : (
        <>
          <Card>
            <p className="mb-2 font-bold" data-testid="accounting-reconciled">
              {t('reconciled')}
            </p>
            <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              <div>
                <dt className="field-label">{t('invoices', { n: result.value.summary.invoices })}</dt>
                <dd>
                  <Money centimes={result.value.summary.salesTtcCentimes} />
                </dd>
              </div>
              <div>
                <dt className="field-label">{t('purchases', { n: result.value.summary.purchases })}</dt>
                <dd>
                  <Money centimes={result.value.summary.purchasesTtcCentimes} />
                </dd>
              </div>
            </dl>
          </Card>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="accounting-files">
            {EXPORT_FILES.map((f) => (
              <li key={f}>
                <a
                  href={`/${locale}/accounting/export?file=${f}&from=${from}&to=${to}`}
                  className="btn btn-secondary w-full"
                  data-testid={`accounting-${f}`}
                >
                  {t(`files.${f}`)}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
