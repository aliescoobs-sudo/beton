import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getStockLevels } from '@/modules/operations';
import { formatStockQty } from '@/modules/operations/ui/format';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** Stock of every component, summed from its movements, with its status against the low threshold. Quantities only. */
export default async function StockPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'stock.read');
  const levels = await getStockLevels(getPool('app'), user);
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
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
