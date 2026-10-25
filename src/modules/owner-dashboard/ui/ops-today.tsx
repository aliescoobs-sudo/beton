import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { TodayOpsView } from '@/modules/rules-engine';
import { AlertsList } from './alerts-list';
import { formatDate, ltr, m3Text } from './format';
import { StockSummary } from './stock-summary';

/** "Aujourd'hui" without money, for office, plant and partner: the loads to make and the stock alerts. No amount anywhere. */
export async function OpsToday({ view, locale }: { view: TodayOpsView; locale: string }) {
  const t = await getTranslations('dashboard');
  return (
    <div className="space-y-10" data-testid="ops-today">
      <p className="text-sm text-muted">{t('ops.noMoney')}</p>
      <section aria-labelledby="ops-loads">
        <h2 id="ops-loads" className="mb-3 text-xl">
          {t('ops.loads')}
        </h2>
        {view.loads.length === 0 ? (
          <p className="text-sm text-muted">{t('ops.loadsNone')}</p>
        ) : (
          <ul data-testid="ops-loads-list">
            {view.loads.map((l) => (
              <li key={l.id} className="row-item text-sm">
                {t('ops.loadLine', {
                  order: ltr(l.code),
                  client: ltr(l.clientCode),
                  type: ltr(l.typeCode),
                  m3: m3Text(l.remainingL),
                  date: formatDate(l.deliveryDate),
                })}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm">
          <Link href={`/${locale}/loads`} className="font-semibold underline">
            {t('sections.loads')}
          </Link>
        </p>
      </section>
      {view.stock && (
        <>
          <section aria-labelledby="ops-alerts">
            <h2 id="ops-alerts" className="mb-3 text-xl">
              {t('ops.stockAlerts')}
            </h2>
            {view.alerts.length === 0 ? (
              <p className="text-sm text-muted">{t('ops.noStockAlerts')}</p>
            ) : (
              <AlertsList
                alerts={view.alerts}
                locale={locale}
                hrefOf={() => `/${locale}/stock/projection`}
                showHistory={false}
              />
            )}
          </section>
          <section aria-labelledby="ops-stock">
            <h2 id="ops-stock" className="mb-3 text-xl">
              {t('sections.stock')}
            </h2>
            <StockSummary stock={view.stock} locale={locale} />
          </section>
        </>
      )}
    </div>
  );
}
