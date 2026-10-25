import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listTrucks } from '@/modules/master-data';
import { listDeliveries, listLoadableOrders } from '@/modules/operations';
import { BlReturnButton } from '@/modules/operations/ui/bl-return-button';
import { formatM3 } from '@/modules/operations/ui/format';
import { LoadRowForm } from '@/modules/operations/ui/load-row-form';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { blReturnAction, cancelLoadAction, createLoadAction } from './actions';

/** The day's loads: orders due with what is left to deliver, one tap to load, and the recent delivery notes. No price. */
export default async function LoadsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'deliveries.read');
  const pool = getPool('app');
  const today = (await getRequestClock()).today();
  const canLoad = can(user.role, 'deliveries.write');
  const [orders, deliveries, trucks] = await Promise.all([
  const canCancel = can(user.role, 'deliveries.cancel');
    listLoadableOrders(pool, user, today),
    listDeliveries(pool, user),
    canLoad ? listTrucks(pool, user) : Promise.resolve([]),
  ]);
  const t = await getTranslations('operations');
  const activeTrucks = trucks
    .filter((k) => k.status === 'active')
    .map((k) => ({ id: k.id, code: k.code, capacityL: k.capacityL }));

  return (
    <div className="space-y-10">
      <PageHeader title={t('loads.title')} description={t('loads.intro')} />
      <section aria-labelledby="due-title">
        <h2 id="due-title" className="mb-3 text-xl">
          {t('loads.dueTitle')}
        </h2>
        {orders.length === 0 ? (
          <EmptyState title={t('loads.noneDue')} data-testid="loads-none" />
        ) : (
          <Table data-testid="loads-due">
            <thead>
              <tr>
                <Th>{t('loads.order')}</Th>
                <Th>{t('loads.type')}</Th>
                <Th>{t('loads.place')}</Th>
                <Th>{t('loads.date')}</Th>
                <Th numeric>{t('loads.remaining')}</Th>
                {canLoad && <Th>{t('loads.load')}</Th>}
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} data-testid={`due-${o.code}`}>
                  <Td>
                    <bdi dir="ltr">{o.code}</bdi>
                    <br />
                    <bdi dir="ltr" className="text-sm text-muted">
                      {o.clientCode}
                    </bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{o.typeCode}</bdi>
                  </Td>
                  <Td>{[o.siteLabel, o.zoneName].filter(Boolean).join(' · ') || '—'}</Td>
                  <Td>
                    <bdi dir="ltr">{o.deliveryDate}</bdi>
                    {o.deliveryDate < today && <StatusPill status="late">{t('loads.overdue')}</StatusPill>}
                  </Td>
                  <Td numeric>
                    {formatM3(o.remainingL)} / {formatM3(o.volumeL)} m³
                  </Td>
                  {canLoad && (
                    <Td>
                      <LoadRowForm
                        orderId={o.id}
                        orderCode={o.code}
                        trucks={activeTrucks}
                        createLoad={createLoadAction}
                      />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="deliveries-title">
        <h2 id="deliveries-title" className="mb-3 text-xl">
          {t('deliveries.title')}
        </h2>
        {deliveries.length === 0 ? (
          <EmptyState title={t('deliveries.none')} data-testid="deliveries-none" />
        ) : (
          <Table data-testid="deliveries-list">
            <thead>
              <tr>
                <Th>{t('deliveries.bl')}</Th>
                <Th>{t('loads.order')}</Th>
                <Th>{t('loads.type')}</Th>
                <Th>{t('loads.truck')}</Th>
                <Th>{t('loads.date')}</Th>
                <Th numeric>{t('deliveries.volume')}</Th>
                <Th>{t('deliveries.signed')}</Th>
              </tr>
                {canCancel && <Th>{t('deliveries.cancelLoad')}</Th>}
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} data-testid={`delivery-${d.blNo}`}>
                  <Td>
                    <a
                      href={`/${locale}/deliveries/${d.id}`}
                      data-testid={`note-link-${d.blNo}`}
                      className="underline"
                    >
                      <bdi dir="ltr">{d.blNo}</bdi>
                    </a>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{d.orderCode ?? '—'}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{d.typeCode ?? '—'}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{d.truckCode}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{d.loadDate}</bdi>
                  </Td>
                  <Td numeric>{formatM3(d.volumeL)} m³</Td>
                  <Td>
                    {d.volumeL < 0 ? (
                      <StatusPill status="cancelled">{t('deliveries.cancelledRow')}</StatusPill>
                    ) : d.cancelled ? (
                      <StatusPill status="cancelled">{t('deliveries.cancelled')}</StatusPill>
                    ) : d.returnedOn ? (
                      <StatusPill status="paid">
                        {t('deliveries.returned')} <bdi dir="ltr">{d.returnedOn}</bdi>
                      </StatusPill>
                    ) : (
                      <BlReturnButton deliveryId={d.id} blNo={d.blNo} today={today} record={blReturnAction} />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
