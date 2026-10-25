import type { DraftSpec } from '@/modules/rules-engine';
import type { T } from './describe';
import { formatDay, m3Text, milliText, moneyText } from './format';

/**
 * The words of a draft message, in the owner's language, from the engine's data. The owner copies it and sends it himself:
 * nothing here is sent, and nothing in it is computed (amounts and dates come from the option).
 */
export function renderDrafts(t: T, locale: string, drafts: readonly DraftSpec[]): string {
  return drafts
    .map((d) => {
      switch (d.type) {
        case 'postpone':
          return t('drafts.postpone', {
            party: d.party,
            code: d.code,
            amount: moneyText(d.amount),
            date: formatDay(d.newDate, locale),
          });
        case 'advance':
          return t('drafts.advance', {
            party: d.party,
            code: d.code,
            amount: moneyText(d.amount),
            date: formatDay(d.byDate, locale),
          });
        case 'discount':
          return t('drafts.discount', {
            party: d.party,
            code: d.code,
            amount: moneyText(d.amount),
            fee: moneyText(d.fee),
            date: formatDay(d.byDate, locale),
          });
        case 'deposit':
          return t('drafts.deposit', {
            party: d.party,
            code: d.code,
            amount: moneyText(d.amount),
            date: formatDay(d.date, locale),
          });
        case 'reminder':
          return t('drafts.reminder', {
            party: d.party,
            total: moneyText(d.total),
            items: d.items
              .map((i) =>
                t('drafts.reminderItem', {
                  code: i.code,
                  amount: moneyText(i.amount),
                  date: formatDay(i.dueDate, locale),
                }),
              )
              .join(', '),
          });
        case 'split':
          return t('drafts.split', {
            party: d.party,
            code: d.code,
            m3: m3Text(d.movedL),
            from: formatDay(d.fromDate, locale),
            to: formatDay(d.toDate, locale),
          });
        case 'purchase':
          return t('drafts.purchase', {
            qty: milliText(d.qtyMilli),
            unit: d.unit,
            party: d.party,
            amount: d.estimatedHt === null ? '—' : moneyText(d.estimatedHt),
            date: d.dueDate ? formatDay(d.dueDate, locale) : '—',
          });
      }
    })
    .join('\n\n');
}
