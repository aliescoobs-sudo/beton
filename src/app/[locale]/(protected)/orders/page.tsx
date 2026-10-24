import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listOrders } from '@/modules/ledger';
import { formatM3 } from '@/modules/operations/ui/format';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** The orders: what was ordered, delivered, invoiced and paid, with what is late. Owner and support (money). */
export default async function OrdersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'orders.read_money');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:orders');
  const today = (await getRequestClock()).today();
  const orders = await listOrders(pool, user, { today });
  const t = await getTranslations('ledger.orderList');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {orders.length === 0 ? (
        <EmptyState title={t('none')} data-testid="orders-none" />
      ) : (
        <Table data-testid="orders-list">
          <thead>
            <tr>
              <Th>{t('code')}</Th>
              <Th>{t('client')}</Th>
              <Th>{t('type')}</Th>
              <Th numeric>{t('delivered')}</Th>
              <Th>{t('deliveryDate')}</Th>
              <Th numeric>{t('total')}</Th>
              <Th numeric>{t('paid')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} data-testid={`order-${o.code}`}>
                <Td>
                  <a href={`/${locale}/orders/${o.id}`} className="underline">
                    <bdi dir="ltr">{o.code}</bdi>
                  </a>
                </Td>
                <Td>
                  <bdi dir="ltr" className="text-sm text-muted">
                    {o.clientCode}
                  </bdi>{' '}
                  {o.clientName}
                </Td>
                <Td>
                  <bdi dir="ltr">{o.typeCode}</bdi>
                </Td>
                <Td numeric>
                  {formatM3(o.deliveredL)} / {formatM3(o.volumeL)} m³
                </Td>
                <Td>
                  <bdi dir="ltr">{o.deliveryDate}</bdi>
                </Td>
                <Td numeric>
                  <Money centimes={o.totalTtcCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={o.coveredCentimes} />
                </Td>
                <Td>
                  {o.cancelled ? (
                    <StatusPill status="cancelled">{t('cancelled')}</StatusPill>
                  ) : o.overdueCentimes > 0 ? (
                    <StatusPill status="late">
                      {t('late')} <Money centimes={o.overdueCentimes} />
                    </StatusPill>
                  ) : o.coveredCentimes >= o.totalTtcCentimes ? (
                    <StatusPill status="paid">{t('settled')}</StatusPill>
                  ) : (
                    <StatusPill status="ontrack">{t('open')}</StatusPill>
                  )}
                  {o.invoiced && <StatusPill status="neutral">{t('invoiced')}</StatusPill>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
