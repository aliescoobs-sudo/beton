import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listQuotes, quoteIsOpen } from '@/modules/ledger';
import { formatM3 } from '@/modules/operations/ui/format';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** The quotes: client, volume, total, validity, and the order each became. Owner and support (money). */
export default async function QuotesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'quotes.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:quotes');
  const [quotes, clock] = await Promise.all([listQuotes(pool, user), getRequestClock()]);
  const today = clock.today();
  const t = await getTranslations('ledger.quotes');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {quotes.length === 0 ? (
        <EmptyState title={t('none')} data-testid="quotes-none" />
      ) : (
        <Table data-testid="quotes-list">
          <thead>
            <tr>
              <Th>{t('code')}</Th>
              <Th>{t('client')}</Th>
              <Th>{t('type')}</Th>
              <Th numeric>{t('volumeShort')}</Th>
              <Th>{t('validUntil')}</Th>
              <Th numeric>{t('totalTtc')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id} data-testid={`quote-${q.code}`}>
                <Td>
                  <a href={`/${locale}/quotes/${q.id}`} className="underline">
                    <bdi dir="ltr">{q.code}</bdi>
                  </a>
                </Td>
                <Td>{q.clientName}</Td>
                <Td>
                  <bdi dir="ltr">{q.typeCode}</bdi>
                </Td>
                <Td numeric>{formatM3(q.volumeL)} m³</Td>
                <Td>
                  <bdi dir="ltr">{q.validUntil}</bdi>
                </Td>
                <Td numeric>
                  <Money centimes={q.totalTtcCentimes} />
                </Td>
                <Td>
                  {q.convertedOrderCode ? (
                    <StatusPill status="paid">
                      {t('converted')} <bdi dir="ltr">{q.convertedOrderCode}</bdi>
                    </StatusPill>
                  ) : quoteIsOpen(q, today) ? (
                    <StatusPill status="ontrack">{t('open')}</StatusPill>
                  ) : (
                    <StatusPill status="cancelled">{t('expired')}</StatusPill>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
