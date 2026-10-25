import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getStockLevels, listStockAdjustments } from '@/modules/operations';
import { CountForm } from '@/modules/operations/ui/count-form';
import { formatStockQty } from '@/modules/operations/ui/format';
import { ThresholdForm } from '@/modules/operations/ui/threshold-form';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { countAction, thresholdAction } from './actions';

/** Stock of every component, summed from its movements, with its status against the low threshold. Quantities only. */
export default async function StockPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'stock.read');
  const levels = await getStockLevels(getPool('app'), user);
  const canSet = can(user.role, 'stock.threshold');
  const canCount = can(user.role, 'stock.count');
  const adjustments = await listStockAdjustments(getPool('app'), user);
  const t = await getTranslations('operations.stock');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {levels.length === 0 ? (
        <EmptyState title={t('none')} data-testid="stock-none" />
      ) : (
        <Table data-testid="stock-levels">
          <thead>
            <tr>
              <Th>{t('component')}</Th>
              <Th numeric>{t('level')}</Th>
              <Th numeric>{t('threshold')}</Th>
              <Th>{t('status')}</Th>
              {canSet && <Th>{t('setThreshold')}</Th>}
              {canCount && <Th>{t('count')}</Th>}
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => {
              const q = formatStockQty(l.level, l.baseUnit);
              const low = l.lowThreshold === null ? null : formatStockQty(l.lowThreshold, l.baseUnit);
              return (
                <tr key={l.componentId} data-testid={`stock-${l.componentId}`} data-status={l.status}>
                  <Td>{locale === 'ar' ? l.nameAr : l.nameFr}</Td>
                  <Td numeric>
                    {q.value} {q.unit}
                  </Td>
                  <Td numeric>{low ? `${low.value} ${low.unit}` : '—'}</Td>
                  <Td>
                    <StatusPill status={l.status === 'ok' ? 'paid' : l.status === 'low' ? 'due' : 'late'}>
                      {t(`statuses.${l.status}`)}
                    </StatusPill>
                  </Td>
                  {canSet && (
                    <Td>
                      <ThresholdForm
                        componentId={l.componentId}
                        baseUnit={l.baseUnit}
                        save={thresholdAction}
                      />
                    </Td>
                  )}
                  {canCount && (
                    <Td>
                      <CountForm componentId={l.componentId} baseUnit={l.baseUnit} count={countAction} />
                    </Td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <section className="mt-10" aria-labelledby="adjustments-title">
        <h2 id="adjustments-title" className="mb-3 text-xl">
          {t('adjustmentsTitle')}
        </h2>
        {adjustments.length === 0 ? (
          <p className="text-sm text-muted" data-testid="adjustments-none">
            {t('adjustmentsNone')}
          </p>
        ) : (
          <Table data-testid="adjustments-list">
            <thead>
              <tr>
                <Th>{t('adjDate')}</Th>
                <Th>{t('component')}</Th>
                <Th numeric>{t('adjDifference')}</Th>
                <Th>{t('adjReason')}</Th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((a) => {
                const q = formatStockQty(Math.abs(a.difference), a.baseUnit);
                return (
                  <tr key={a.id} data-testid={`adjustment-${a.id}`}>
                    <Td>
                      <bdi dir="ltr">{a.date}</bdi>
                    </Td>
                    <Td>{locale === 'ar' ? a.nameAr : a.nameFr}</Td>
                    <Td numeric>
                      {a.difference < 0 ? '−' : '+'}
                      {q.value} {q.unit}
                    </Td>
                    <Td>{a.reason}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
