import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listPlants } from '@/modules/master-data';
import {
  listArrivalFiles,
  listReceiptStates,
  listReceiptVariances,
  listReceivable,
} from '@/modules/operations';
import { getRequestClock } from '@/app/request-clock';
import { ConfirmArrivalButton } from '@/modules/operations/ui/confirm-arrival-button';
import { formatM3 } from '@/modules/operations/ui/format';
import { ReceiveButton } from '@/modules/operations/ui/receive-button';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { attachArrivalFileAction, confirmArrivalAction, receiveAction } from './actions';

/** Purchases with stocked lines: what is expected (receive it) and what came in. Quantities only, no price. */
export default async function ReceiptsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'receipts.read');
  const purchases = (await listReceivable(getPool('app'), user)).filter((p) => !p.cancelled);
  // With plants set up a receipt has two steps: the plant confirms the arrival, then the office records it (D133).
  const twoStep = (await listPlants(getPool('app'), user)).some((p) => p.status === 'active');
  const canConfirm = twoStep && can(user.role, 'receipts.confirm_arrival');
  const canReceive = can(user.role, 'receipts.write') && !(twoStep && user.role === 'plant');
  const t = await getTranslations('operations.receipts');
  // The last 30 days of arrivals with their state (§16.7): arrived, available for production, documented.
  const today = (await getRequestClock()).today();
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  const states = await listReceiptStates(getPool('app'), user, { since });
  const files = await listArrivalFiles(
    getPool('app'),
    user,
    states.map((s) => s.confirmationId),
  );
  const variances = await listReceiptVariances(
    getPool('app'),
    user,
    states.map((s) => s.confirmationId),
  );
  const varianceOf = (confirmationId: string, lineId: string) =>
    variances.find((v) => v.confirmationId === confirmationId && v.lineId === lineId);
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {purchases.length === 0 ? (
        <EmptyState title={t('none')} data-testid="receipts-none" />
      ) : (
        <Table data-testid="receipts-list">
          <thead>
            <tr>
              <Th>{t('purchase')}</Th>
              <Th>{t('supplier')}</Th>
              <Th>{t('date')}</Th>
              <Th>{t('lines')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.purchaseId} data-testid={`purchase-${p.code}`}>
                <Td>
                  <bdi dir="ltr">{p.code}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{p.supplierCode}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{p.orderDate}</bdi>
                </Td>
                <Td>
                  <ul>
                    {p.lines.map((l, i) => (
                      <li key={i}>
                        {locale === 'ar' ? l.nameAr : l.nameFr} ·{' '}
                        <bdi dir="ltr">
                          {formatM3(l.receivedMilli)} / {formatM3(l.qtyMilli)} {l.unitLabel}
                        </bdi>
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td>
                  {p.status === 'complete' ? (
                    <StatusPill status="paid">
                      {t('receivedOn')} <bdi dir="ltr">{p.receivedOn}</bdi>
                    </StatusPill>
                  ) : (
                    <div className="space-y-2">
                      {p.status === 'partial' && (
                        <StatusPill status="due" data-testid={`partial-${p.code}`}>
                          {t('partialState', { count: p.receipts })}
                        </StatusPill>
                      )}
                      {canConfirm && !p.arrivalConfirmed && (
                        <ConfirmArrivalButton
                          purchaseId={p.purchaseId}
                          code={p.code}
                          lines={p.lines.map((l) => ({
                            lineId: l.lineId,
                            name: locale === 'ar' ? l.nameAr : l.nameFr,
                            unit: l.unitLabel,
                            ordered: l.qtyMilli,
                            received: l.receivedMilli,
                          }))}
                          confirm={confirmArrivalAction}
                          attachFile={attachArrivalFileAction}
                        />
                      )}
                      {twoStep && p.arrivalConfirmed && (
                        <StatusPill status="due" data-testid={`arrival-confirmed-${p.code}`}>
                          {t('arrivalConfirmed')}
                        </StatusPill>
                      )}
                      {canReceive && (!twoStep || p.arrivalConfirmed) ? (
                        <ReceiveButton
                          purchaseId={p.purchaseId}
                          code={p.code}
                          canConfirmExcess={can(user.role, 'ledger.reverse')}
                          lines={p.lines.map((l) => ({
                            lineId: l.lineId,
                            name: locale === 'ar' ? l.nameAr : l.nameFr,
                            unit: l.unitLabel,
                            ordered: l.qtyMilli,
                            received: l.receivedMilli,
                          }))}
                          receive={receiveAction}
                        />
                      ) : p.status === 'expected' && !canConfirm ? (
                        <StatusPill status="due">{t('expected')}</StatusPill>
                      ) : null}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {states.length > 0 && (
        <section
          className="mt-10 space-y-2"
          data-testid="receipt-states"
          aria-labelledby="receipt-states-title"
        >
          <h2 id="receipt-states-title" className="text-xl">
            {t('statesTitle')}
          </h2>
          <ul className="space-y-3">
            {states.map((s) => (
              <li key={s.confirmationId} data-testid={`receipt-state-${s.purchaseCode}`} data-state={s.state}>
                <p className="flex flex-wrap items-center gap-2">
                  <bdi dir="ltr" className="font-semibold">
                    {s.purchaseCode}
                  </bdi>
                  <StatusPill
                    status={s.state === 'documented' ? 'paid' : s.state === 'available' ? 'due' : 'late'}
                  >
                    {t(`states.${s.state}`)}
                  </StatusPill>
                  {s.lines.some((l) => l.rejectedMilli > 0) && (
                    <StatusPill status="late">{t('hasRejected')}</StatusPill>
                  )}
                  {s.lines.some((l) => l.partial) && <StatusPill status="due">{t('hasPartial')}</StatusPill>}
                  {s.lines.some((l) => varianceOf(s.confirmationId, l.lineId)?.overThreshold) && (
                    <StatusPill status="late" data-testid={`variance-${s.purchaseCode}`}>
                      {t('hasVariance')}
                    </StatusPill>
                  )}
                </p>
                <ul className="text-sm">
                  {s.lines
                    .filter((l) => l.arrivedMilli > 0 || s.lines.every((x) => x.arrivedMilli === 0))
                    .map((l) => (
                      <li key={l.lineId}>
                        {locale === 'ar' ? l.nameAr : l.nameFr} ·{' '}
                        <bdi dir="ltr">
                          {formatM3(l.arrivedMilli)} {t('arrivedShort')}
                          {l.rejectedMilli > 0
                            ? ` · ${formatM3(l.rejectedMilli)} ${t('rejectedShort')}`
                            : ''}{' '}
                          / {formatM3(l.orderedMilli)} {l.unitLabel}
                        </bdi>
                        {l.available && !s.documented ? ` · ${t('usableNow')}` : ''}
                        {(() => {
                          const v = varianceOf(s.confirmationId, l.lineId);
                          return v && v.varianceMilli !== 0 ? (
                            <span data-testid={`variance-line-${s.purchaseCode}`}>
                              {' · '}
                              <bdi dir="ltr">
                                {t('varianceLine', {
                                  plant: formatM3(v.plantMilli),
                                  office: formatM3(v.officeMilli),
                                  gap: `${v.varianceMilli > 0 ? '+' : ''}${formatM3(v.varianceMilli)}`,
                                  percent: (v.varianceBp / 100).toFixed(2),
                                })}
                              </bdi>
                            </span>
                          ) : null;
                        })()}
                      </li>
                    ))}
                </ul>
                {files
                  .filter((f) => f.confirmationId === s.confirmationId)
                  .map((f) => (
                    <a
                      key={f.id}
                      href={`/${locale}/receipts/arrival-file/${f.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="me-3 text-sm underline"
                      data-testid={`arrival-file-${f.id}`}
                    >
                      {t(`fileKinds.${f.kind}`)}
                    </a>
                  ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
