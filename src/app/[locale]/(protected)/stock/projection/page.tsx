import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getEngineParams } from '@/app/engine-params';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { formatDay, qtyText } from '@/modules/owner-dashboard';
import { requirePagePermission } from '@/modules/platform-security/next';
import { loadTodayOps } from '@/modules/rules-engine';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** Day by day, what the open orders take from each component against the stock and the receipts expected. Quantities only. */
export default async function StockProjectionPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'stock.read');
  const today = (await getRequestClock()).today();
  const view = await loadTodayOps(getPool('app'), user, { today, params: await getEngineParams() });
  const t = await getTranslations('dashboard.stockRisk');
  const components = (view.stock?.components ?? []).filter(
    (c) => c.needs > 0 || c.firstShortage || c.firstLow,
  );
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {view.stock && view.stock.missingRecette.length > 0 && (
        <p className="mb-4 font-semibold" data-testid="stock-missing-recette">
          {t('missingRecette', { count: view.stock.missingRecette.length })}
        </p>
      )}
      {components.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <div className="space-y-8">
          {components.map((c) => (
            <section
              key={c.componentId}
              data-testid={`projection-${c.componentId}`}
              aria-labelledby={`h-${c.componentId}`}
            >
              <h2 id={`h-${c.componentId}`} className="mb-1 text-xl">
                {locale === 'ar' ? c.nameAr : c.nameFr}
              </h2>
              <p className="mb-2 flex flex-wrap items-center gap-3 text-sm">
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
                {c.maxShortage > 0 && (
                  <span className="font-semibold">
                    {t('missing', { qty: qtyText(c.maxShortage, c.baseUnit) })}
                  </span>
                )}
              </p>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('day')}</Th>
                    <Th numeric>{t('demand')}</Th>
                    <Th numeric>{t('in')}</Th>
                    <Th numeric>{t('levelOn')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {c.days.map((d) => (
                    <tr key={d.date} data-negative={d.level < 0 ? 'true' : 'false'}>
                      <Td>{formatDay(d.date, locale)}</Td>
                      <Td numeric>{d.demand > 0 ? qtyText(d.demand, c.baseUnit) : '—'}</Td>
                      <Td numeric>{d.receipts > 0 ? qtyText(d.receipts, c.baseUnit) : '—'}</Td>
                      <Td numeric>
                        <span className={d.level < 0 ? 'font-semibold text-status-late' : ''}>
                          {d.level < 0 && <span aria-hidden="true">▲ </span>}
                          {qtyText(d.level, c.baseUnit)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
