import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { type Dimension, getVolumeAnalytics, type ReportPeriod } from '@/modules/operations';
import { formatM3 } from '@/modules/operations/ui/format';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, EmptyState, Input, Money, PageHeader, Select, Table, Td, Th } from '@/ui';

const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** m³ delivered per day, week or month, per client, concrete type or zone. The amounts only for the owner and support. */
export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; to?: string; period?: string; by?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'analytics.read');
  const query = await searchParams;
  const today = (await getRequestClock()).today();
  const to = query.to && isRealDate(query.to) ? query.to : today;
  const from = query.from && isRealDate(query.from) ? query.from : addDays(to, -89);
  const period: ReportPeriod = query.period === 'day' || query.period === 'week' ? query.period : 'month';
  const dimension: Dimension = query.by === 'client' || query.by === 'zone' ? query.by : 'type';
  const result = await getVolumeAnalytics(getPool('app'), user, { from, to, period, dimension });
  const t = await getTranslations('operations.analytics');
  const th = await getTranslations('historyImport');
  if (!result.ok) return <PageHeader title={t('title')} description={t('invalid')} />;
  const r = result.value;
  const amountOf = (period: string, key: string) =>
    r.amounts?.find((a) => a.period === period && a.key === key)?.amountHtCentimes;
  const total = r.volume.reduce((s, v) => s + v.volumeL, 0);

  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} description={t('intro')} />
      {can(user.role, 'history.read') && (
        <p className="text-sm">
          <a href={`/${locale}/history`} className="underline" data-testid="analytics-history-link">
            {th('analyticsLink')}
          </a>
        </p>
      )}
      <form method="get" className="flex flex-wrap items-end gap-3" data-testid="analytics-form">
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <Input type="date" name="from" defaultValue={from} dir="ltr" data-testid="analytics-from" />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <Input type="date" name="to" defaultValue={to} dir="ltr" data-testid="analytics-to" />
        </label>
        <label className="block">
          <span className="field-label">{t('period')}</span>
          <Select name="period" defaultValue={period} data-testid="analytics-period">
            <option value="day">{t('periods.day')}</option>
            <option value="week">{t('periods.week')}</option>
            <option value="month">{t('periods.month')}</option>
          </Select>
        </label>
        <label className="block">
          <span className="field-label">{t('by')}</span>
          <Select name="by" defaultValue={dimension} data-testid="analytics-by">
            <option value="type">{t('dimensions.type')}</option>
            <option value="client">{t('dimensions.client')}</option>
            <option value="zone">{t('dimensions.zone')}</option>
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          {t('show')}
        </Button>
      </form>

      {r.volume.length === 0 ? (
        <EmptyState title={t('none')} data-testid="analytics-none" />
      ) : (
        <Table data-testid="analytics-table">
          <thead>
            <tr>
              <Th>{t('period')}</Th>
              <Th>{t(`dimensions.${dimension}`)}</Th>
              <Th numeric>{t('volume')}</Th>
              {r.amounts && <Th numeric>{t('amount')}</Th>}
            </tr>
          </thead>
          <tbody>
            {r.volume.map((v) => {
              const amount = amountOf(v.period, v.key);
              return (
                <tr key={`${v.period}-${v.key}`} data-testid={`analytics-${v.period}-${v.label}`}>
                  <Td>
                    <bdi dir="ltr">{v.period}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{v.label}</bdi>
                  </Td>
                  <Td numeric>
                    <bdi dir="ltr">{formatM3(v.volumeL)} m³</bdi>
                  </Td>
                  {r.amounts && <Td numeric>{amount === undefined ? '—' : <Money centimes={amount} />}</Td>}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <p className="text-sm font-semibold" data-testid="analytics-total">
        {t('total')} <bdi dir="ltr">{formatM3(total)} m³</bdi>
      </p>
      <p className="text-sm text-muted">{r.amounts ? t('noteMoney') : t('note')}</p>
    </div>
  );
}
