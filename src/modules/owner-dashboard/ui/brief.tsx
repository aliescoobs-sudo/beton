import { getTranslations } from 'next-intl/server';
import type { DashboardView } from '@/modules/rules-engine';
import { formatDay, moneyText } from './format';

/** The daily brief as template text from the same facts (the AI layer may phrase it later; with AI off this is the brief). */
export async function Brief({ view, locale }: { view: DashboardView; locale: string }) {
  const t = await getTranslations('dashboard');
  const count = (s: string) => view.alerts.filter((a) => a.severity === s).length;
  const short = view.stock.components.filter((c) => c.firstShortage).length;
  const low = view.stock.components.filter((c) => c.firstLow).length;
  const lines = [
    t('brief.cash', { real: moneyText(view.cash.real), total: moneyText(view.cash.total) }),
    view.black
      ? t('brief.black', {
          date: formatDay(view.black.date, locale),
          shortfall: moneyText(view.black.shortfall),
        })
      : view.lowest
        ? t('brief.low', {
            date: formatDay(view.lowest.date, locale),
            balance: moneyText(view.lowest.balance),
          })
        : '',
    !view.black && view.forecast.length > 0 ? t('brief.fine', { days: view.forecast.length - 1 }) : '',
    view.alerts.length === 0
      ? t('brief.noAlerts')
      : t('brief.alerts', {
          count: view.alerts.length,
          risk: count('risk'),
          urgent: count('urgent'),
          important: count('important'),
          probable: count('probable'),
        }),
    short + low === 0 ? t('brief.noStock') : t('brief.stock', { short, low }),
    view.loads.length === 0 ? t('brief.noLoads') : t('brief.loads', { count: view.loads.length }),
  ].filter(Boolean);
  return (
    <ul className="space-y-1" data-testid="brief">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}
