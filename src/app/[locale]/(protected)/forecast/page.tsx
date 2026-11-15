import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getCashForecast } from '@/modules/ledger';
import { recordMoneyView } from '@/modules/platform-security';
import { requireAnyPagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, Table, Td, Th } from '@/ui';

const COLS = ['overdue', 'd30', 'd60', 'd90'] as const;

/**
 * T19c B3 (D245): what is expected to move in the next 30, 60 and 90 days: client cheques due, cheques issued to suppliers due, loan and leasing instalments.
 * The Responsable sees the client cheques, the Assistante the issued cheques, owner and app_admin both with the instalments and the net line.
 */
export default async function ForecastPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireAnyPagePermission(locale, ['forecast.client', 'forecast.supplier']);
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:forecast');
  const today = (await getRequestClock()).today();
  const f = await getCashForecast(pool, user, { today });
  const t = await getTranslations('ledger.forecast');
  const tl = await getTranslations('list');
  const row = (key: string, label: string, v: Record<(typeof COLS)[number], number>, strong = false) => (
    <tr key={key} data-testid={`forecast-${key}`} className={strong ? 'font-semibold' : undefined}>
      <Td>{label}</Td>
      {COLS.map((c) => (
        <Td key={c} numeric>
          <Money centimes={v[c]} />
        </Td>
      ))}
    </tr>
  );
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro', { date: today })} />
      <Table data-testid="forecast-table">
        <thead>
          <tr>
            <Th>{t('line')}</Th>
            {COLS.map((c) => (
              <Th key={c} numeric>
                {t(`col.${c}`)}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {f.sides.client && row('client_cheque', t('kind.client_cheque'), f.byKind.client_cheque)}
          {f.sides.supplier && row('issued_cheque', t('kind.issued_cheque'), f.byKind.issued_cheque)}
          {f.sides.instalments && row('instalment', t('kind.instalment'), f.byKind.instalment)}
          {f.sides.net && row('in', t('incoming'), f.incoming)}
          {f.sides.net && row('out', t('outgoing'), f.outgoing)}
          {f.sides.net && row('net', t('net'), f.net, true)}
        </tbody>
      </Table>
      <h2 className="mt-6 text-lg">{t('detail')}</h2>
      {f.items.length === 0 ? (
        <EmptyState title={tl('noMatch')} description={t('none')} />
      ) : (
        <Table data-testid="forecast-items">
          <thead>
            <tr>
              <Th>{t('due')}</Th>
              <Th>{t('what')}</Th>
              <Th>{t('party')}</Th>
              <Th numeric>{t('amount')}</Th>
            </tr>
          </thead>
          <tbody>
            {f.items.map((i, n) => (
              <tr key={`${i.kind}-${n}`}>
                <Td>
                  <bdi dir="ltr">{i.dueDate}</bdi> {i.dueDate < today && <span>({t('col.overdue')})</span>}
                </Td>
                <Td>
                  {t(`kind.${i.kind}`)} <bdi dir="ltr">{i.label}</bdi>
                </Td>
                <Td>
                  <bdi>{i.party ?? '—'}</bdi>
                </Td>
                <Td numeric>
                  <Money centimes={i.side === 'in' ? i.amountCentimes : -i.amountCentimes} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
