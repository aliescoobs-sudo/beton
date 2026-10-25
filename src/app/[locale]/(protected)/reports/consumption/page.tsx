import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { getConsumptionReport, type ReportPeriod } from '@/modules/operations';
import { formatM3, formatStockQty } from '@/modules/operations/ui/format';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, EmptyState, Input, PageHeader, Select, StatusPill, Table, Td, Th } from '@/ui';

const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "+2,0 %" with a decimal comma, from basis points. */
const percent = (bp: number): string => {
  const tenths = Math.round(bp / 10);
  return `${tenths > 0 ? '+' : ''}${(tenths / 10).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
};

/** Production per concrete type and theoretical consumption per component against the counts. Quantities only. */
export default async function ConsumptionReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; to?: string; period?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'reports.consumption');
  const query = await searchParams;
  const today = (await getRequestClock()).today();
  const to = query.to && isRealDate(query.to) ? query.to : today;
  const from = query.from && isRealDate(query.from) ? query.from : addDays(to, -29);
  const period: ReportPeriod = query.period === 'day' || query.period === 'month' ? query.period : 'week';
  const report = await getConsumptionReport(getPool('app'), user, { from, to, period });
  const t = await getTranslations('operations.report');
  if (!report.ok) return <PageHeader title={t('title')} description={t('invalid')} />;
  const r = report.value;
  const name = (id: string) => {
    const c = r.components.find((x) => x.id === id);
    return c ? (locale === 'ar' ? c.nameAr : c.nameFr) : id;
  };
  const unit = (id: string) => r.components.find((x) => x.id === id)?.baseUnit ?? 'g';

  return (
    <div className="space-y-10">
      <PageHeader title={t('title')} description={t('intro')} />
      <form method="get" className="flex flex-wrap items-end gap-3" data-testid="report-form">
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <Input type="date" name="from" defaultValue={from} dir="ltr" data-testid="report-from" />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <Input type="date" name="to" defaultValue={to} dir="ltr" data-testid="report-to" />
        </label>
        <label className="block">
          <span className="field-label">{t('period')}</span>
          <Select name="period" defaultValue={period} data-testid="report-period">
            <option value="day">{t('periods.day')}</option>
            <option value="week">{t('periods.week')}</option>
            <option value="month">{t('periods.month')}</option>
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          {t('show')}
        </Button>
      </form>

      <section aria-labelledby="produced-title">
        <h2 id="produced-title" className="mb-3 text-xl">
          {t('producedTitle')}
        </h2>
        {r.produced.length === 0 ? (
          <EmptyState title={t('producedNone')} data-testid="produced-none" />
        ) : (
          <Table data-testid="produced-table">
            <thead>
              <tr>
                <Th>{t('period')}</Th>
                <Th>{t('type')}</Th>
                <Th numeric>{t('produced')}</Th>
              </tr>
            </thead>
            <tbody>
              {r.produced.map((p) => (
                <tr key={`${p.period}-${p.typeId}`} data-testid={`produced-${p.period}-${p.typeLabel}`}>
                  <Td>
                    <bdi dir="ltr">{p.period}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{p.typeLabel}</bdi>
                  </Td>
                  <Td numeric>
                    <bdi dir="ltr">{formatM3(p.volumeL)} m³</bdi>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="consumption-title">
        <h2 id="consumption-title" className="mb-1 text-xl">
          {t('consumptionTitle')}
        </h2>
        <p className="mb-3 text-sm text-muted">
          {t('consumptionIntro', { tolerance: percent(r.toleranceBp).replace('+', '') })}
        </p>
        {r.consumption.length === 0 ? (
          <EmptyState title={t('consumptionNone')} data-testid="consumption-none" />
        ) : (
          <Table data-testid="consumption-table">
            <thead>
              <tr>
                <Th>{t('period')}</Th>
                <Th>{t('component')}</Th>
                <Th numeric>{t('theoretical')}</Th>
                <Th numeric>{t('adjustments')}</Th>
                <Th numeric>{t('actual')}</Th>
                <Th numeric>{t('variance')}</Th>
                <Th>{t('status')}</Th>
              </tr>
            </thead>
            <tbody>
              {r.consumption.map((c) => {
                const q = (n: number) => {
                  const f = formatStockQty(Math.abs(n), unit(c.componentId));
                  return `${n < 0 ? '−' : ''}${f.value} ${f.unit}`;
                };
                return (
                  <tr
                    key={`${c.period}-${c.componentId}`}
                    data-testid={`consumption-${c.period}-${c.componentId}`}
                    data-flagged={c.flagged ? 'true' : 'false'}
                  >
                    <Td>
                      <bdi dir="ltr">{c.period}</bdi>
                    </Td>
                    <Td>{name(c.componentId)}</Td>
                    <Td numeric>
                      <bdi dir="ltr">{q(c.theoretical)}</bdi>
                    </Td>
                    <Td numeric>{c.counted ? <bdi dir="ltr">{q(c.adjustments)}</bdi> : '—'}</Td>
                    <Td numeric>{c.actual === null ? '—' : <bdi dir="ltr">{q(c.actual)}</bdi>}</Td>
                    <Td numeric>
                      {c.variance === null ? (
                        '—'
                      ) : (
                        <bdi dir="ltr">
                          {q(c.variance)}
                          {c.varianceBp !== null ? ` (${percent(c.varianceBp)})` : ''}
                        </bdi>
                      )}
                    </Td>
                    <Td>
                      {!c.counted ? (
                        <StatusPill status="due">{t('noCount')}</StatusPill>
                      ) : c.flagged ? (
                        <StatusPill status="late">{t('flagged')}</StatusPill>
                      ) : (
                        <StatusPill status="paid">{t('withinTolerance')}</StatusPill>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="mt-2 text-sm text-muted">{t('countNote')}</p>
      </section>
    </div>
  );
}
