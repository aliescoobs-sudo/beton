import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { clockText } from '@/modules/operations/domain/dispatch';
import { getOfficeDispatch } from '@/modules/operations';
import { formatM3 } from '@/modules/operations/ui/format';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, EmptyState, Input, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/**
 * Where is my truck: the day's rotations for office, read-only. Truck, times, m³, client name and the step reached; no price,
 * no amount, no order. What office may see is decided by one database function, not by this page.
 */
export default async function OfficeDispatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'dispatch.read_office');
  const query = await searchParams;
  const today = (await getRequestClock()).today();
  const date = query.date && isRealDate(query.date) ? query.date : today;
  const rows = await getOfficeDispatch(getPool('app'), user, date);
  const t = await getTranslations('operations.officeDispatch');
  const tStep = await getTranslations('operations.trips.step');
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('intro')} />
      <form method="get" className="flex flex-wrap items-end gap-2" data-testid="office-dispatch-date-form">
        <label className="block">
          <span className="field-label">{t('date')}</span>
          <Input type="date" name="date" defaultValue={date} dir="ltr" data-testid="office-dispatch-date" />
        </label>
        <Button type="submit" variant="secondary">
          {t('show')}
        </Button>
      </form>
      {!rows.ok || rows.value.length === 0 ? (
        <EmptyState title={t('none')} data-testid="office-dispatch-none" />
      ) : (
        <Table data-testid="office-dispatch">
          <thead>
            <tr>
              <Th>{t('truck')}</Th>
              <Th>{t('client')}</Th>
              <Th>{t('place')}</Th>
              <Th numeric>{t('volume')}</Th>
              <Th>{t('times')}</Th>
              <Th>{t('step')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.value.map((r) => (
              <tr key={r.tripId} data-testid={`office-rotation-${r.truckCode}-${r.loadMin}`}>
                <Td>
                  <bdi dir="ltr">{r.truckCode}</bdi>
                  <br />
                  <bdi dir="ltr" className="text-sm text-muted">
                    {r.truckPlate}
                  </bdi>
                </Td>
                <Td>{r.clientName}</Td>
                <Td>{[r.siteLabel, r.zoneName].filter(Boolean).join(' · ') || '—'}</Td>
                <Td numeric>
                  <bdi dir="ltr">{formatM3(r.volumeL)} m³</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">
                    {clockText(r.loadMin)} → {clockText(r.arriveMin)} → {clockText(r.backMin)}
                  </bdi>
                </Td>
                <Td>
                  <StatusPill status={r.step === null ? 'due' : r.step === 'back' ? 'paid' : 'ontrack'}>
                    {r.step === null ? t('planned') : tStep(r.step)}
                  </StatusPill>
                  {r.blNo && (
                    <>
                      {' '}
                      <bdi dir="ltr" className="text-sm">
                        {r.blNo}
                      </bdi>
                    </>
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
