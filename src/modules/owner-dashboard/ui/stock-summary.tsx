import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { StockRisk } from '@/modules/rules-engine';
import { StatusPill, Table, Td, Th } from '@/ui';
import { formatDay, qtyText } from './format';

/** What the open orders will take from the stock in the coming days, component by component. Quantities only. */
export async function StockSummary({
  stock,
  locale,
  limit = 6,
}: {
  stock: StockRisk;
  locale: string;
  limit?: number;
}) {
  const t = await getTranslations('dashboard.stockRisk');
  const rank = (c: StockRisk['components'][number]) => (c.firstShortage ? 0 : c.firstLow ? 1 : 2);
  const rows = [...stock.components]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.daysUntilShortage ?? 999) - (b.daysUntilShortage ?? 999) ||
        a.nameFr.localeCompare(b.nameFr),
    )
    .filter((c) => c.needs > 0 || rank(c) < 2)
    .slice(0, limit);
  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('none')}</p>
      ) : (
        <Table data-testid="stock-summary">
          <thead>
            <tr>
              <Th>{t('component')}</Th>
              <Th numeric>{t('level')}</Th>
              <Th numeric>{t('needs')}</Th>
              <Th numeric>{t('low')}</Th>
              <Th>{t('status')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.componentId}
                data-testid={`stock-risk-${c.componentId}`}
                data-status={rank(c) === 0 ? 'short' : rank(c) === 1 ? 'low' : 'ok'}
              >
                <Td>{locale === 'ar' ? c.nameAr : c.nameFr}</Td>
                <Td numeric>{qtyText(c.level, c.baseUnit)}</Td>
                <Td numeric>{qtyText(c.needs, c.baseUnit)}</Td>
                <Td numeric>{qtyText(c.minLevel, c.baseUnit)}</Td>
                <Td>
                  {c.firstShortage ? (
                    <StatusPill status="late">
                      <span aria-hidden="true">▲ </span>
                      {t('shortageOn', { date: formatDay(c.firstShortage.date, locale) })}
                    </StatusPill>
                  ) : c.firstLow ? (
                    <StatusPill status="due">
                      <span aria-hidden="true">◆ </span>
                      {t('lowOn', { date: formatDay(c.firstLow.date, locale) })}
                    </StatusPill>
                  ) : (
                    <StatusPill status="paid">{t('ok')}</StatusPill>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {stock.missingRecette.length > 0 && (
        <p className="text-sm font-semibold" data-testid="stock-missing-recette">
          {t('missingRecette', { count: stock.missingRecette.length })}
        </p>
      )}
      <Link href={`/${locale}/stock/projection`} className="text-sm font-semibold underline">
        {t('details')}
      </Link>
    </div>
  );
}
