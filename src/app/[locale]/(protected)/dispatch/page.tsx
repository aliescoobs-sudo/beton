import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { getDispatchDay, listDrivers } from '@/modules/operations';
import { DispatchBoard } from '@/modules/operations/ui/dispatch-board';
import { DriverForm } from '@/modules/operations/ui/driver-form';
import { formatM3 } from '@/modules/operations/ui/format';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, EmptyState, Input, PageHeader, Table, Td, Th } from '@/ui';
import { createDriverAction, saveDispatchAction } from './actions';

/** The day's dispatch: each order of the day cut into truck rotations, with truck, driver and times. Quantities and times only. */
export default async function DispatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'dispatch.read');
  const query = await searchParams;
  const today = (await getRequestClock()).today();
  const date = query.date && isRealDate(query.date) ? query.date : today;
  const pool = getPool('app');
  const day = await getDispatchDay(pool, user, date);
  const t = await getTranslations('operations');
  if (!day.ok) return <PageHeader title={t('dispatch.title')} description={t('dispatch.errors.INVALID')} />;
  const canWrite = can(user.role, 'dispatch.write');
  const canDrivers = can(user.role, 'drivers.write');
  const drivers = await listDrivers(pool, user);

  return (
    <div className="space-y-10">
      <PageHeader title={t('dispatch.title')} description={t('dispatch.intro')} />
      <form method="get" className="flex flex-wrap items-end gap-2" data-testid="dispatch-date-form">
        <label className="block">
          <span className="field-label">{t('dispatch.date')}</span>
          <Input type="date" name="date" defaultValue={date} dir="ltr" data-testid="dispatch-date" />
        </label>
        <Button type="submit" variant="secondary">
          {t('dispatch.show')}
        </Button>
      </form>

      <section aria-labelledby="day-orders-title">
        <h2 id="day-orders-title" className="mb-3 text-xl">
          {t('dispatch.ordersTitle')}
        </h2>
        {day.value.orders.length === 0 ? (
          <EmptyState title={t('dispatch.noOrders')} data-testid="dispatch-no-orders" />
        ) : (
          <Table data-testid="dispatch-orders">
            <thead>
              <tr>
                <Th>{t('loads.order')}</Th>
                <Th>{t('loads.type')}</Th>
                <Th>{t('loads.place')}</Th>
                <Th numeric>{t('dispatch.oneWay')}</Th>
                <Th numeric>{t('loads.remaining')}</Th>
              </tr>
            </thead>
            <tbody>
              {day.value.orders.map((o) => (
                <tr key={o.orderId} data-testid={`day-order-${o.orderCode}`}>
                  <Td>
                    <bdi dir="ltr">{o.orderCode}</bdi>
                    <br />
                    <bdi dir="ltr" className="text-sm text-muted">
                      {o.clientCode}
                    </bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{o.typeLabel}</bdi>
                  </Td>
                  <Td>{[o.siteLabel, o.zoneName].filter(Boolean).join(' · ') || '—'}</Td>
                  <Td numeric>{o.oneWayMin === null ? '—' : <bdi dir="ltr">{o.oneWayMin} min</bdi>}</Td>
                  <Td numeric>
                    <bdi dir="ltr">{formatM3(o.remainingL)} m³</bdi>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <DispatchBoard
        key={`${date}-${day.value.saved.map((s) => s.key).join(',')}`}
        day={day.value}
        canWrite={canWrite}
        save={saveDispatchAction}
      />

      <section aria-labelledby="drivers-title">
        <h2 id="drivers-title" className="mb-3 text-xl">
          {t('dispatch.driversTitle')}
        </h2>
        {drivers.length === 0 ? (
          <p className="text-sm text-muted" data-testid="drivers-none">
            {t('dispatch.driversNone')}
          </p>
        ) : (
          <ul className="text-sm" data-testid="drivers-list">
            {drivers.map((d) => (
              <li key={d.id} className="row-item" data-testid={`driver-${d.code}`}>
                <bdi dir="ltr">{d.code}</bdi> · {d.name}
              </li>
            ))}
          </ul>
        )}
        {canDrivers && (
          <div className="mt-3">
            <DriverForm create={createDriverAction} />
          </div>
        )}
      </section>
    </div>
  );
}
