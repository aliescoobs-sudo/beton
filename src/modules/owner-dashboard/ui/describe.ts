import type { AlertView, CashOption, InformationalOption, StockOption } from '@/modules/rules-engine';
import { formatDay, ltr, m3Text, milliText, moneyText, qtyText } from './format';

/** The translator of the `dashboard` namespace (server or client): the engine supplies data, these helpers supply sentences. */
export type T = (key: string, values?: Record<string, string | number>) => string;

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => String(v ?? '');

/** One sentence for an alert, from its rule and its data (no number is computed here, only formatted). */
export function alertText(
  t: T,
  locale: string,
  a: Pick<AlertView, 'ruleId' | 'params' | 'targetDate'>,
): string {
  const p = a.params;
  const date = formatDay(a.targetDate, locale);
  const name = locale === 'ar' ? str(p.nameAr) : str(p.nameFr);
  switch (a.ruleId) {
    case 'CASH-DEFICIT':
    case 'CASH-DEFICIT-WORST':
      return t(`rules.${a.ruleId}`, { date, shortfall: moneyText(num(p.shortfall)) });
    case 'PAY-DUE':
    case 'RCV-DUE':
      return t(`rules.${a.ruleId}`, {
        date,
        party: str(p.party),
        code: ltr(str(p.code)),
        amount: moneyText(num(p.amount)),
      });
    case 'RCV-OVERDUE':
      return t('rules.RCV-OVERDUE', {
        days: num(p.daysLate),
        party: str(p.party),
        code: ltr(str(p.code)),
        amount: moneyText(num(p.amount)),
      });
    case 'CHQ-BOUNCED': {
      const key = p.reminder ? `rules.CHQ-BOUNCED-${str(p.reminder)}` : 'rules.CHQ-BOUNCED';
      return t(key, {
        label: str(p.label),
        party: str(p.party),
        amount: moneyText(num(p.amount)),
        daysLeft: Math.max(0, num(p.daysLeft)),
        date: formatDay(a.targetDate, locale),
      });
    }
    case 'STOCK-SHORTAGE':
      return t('rules.STOCK-SHORTAGE', {
        component: name,
        date,
        missing: qtyText(num(p.missing), str(p.unit)),
      });
    case 'STOCK-LOW':
      return t('rules.STOCK-LOW', {
        component: name,
        date,
        level: qtyText(num(p.level), str(p.unit)),
        threshold: qtyText(num(p.threshold), str(p.unit)),
      });
    case 'LAW6921-RECEIVABLE':
    case 'LAW6921-PAYABLE':
      return t(num(p.overdue) === 1 ? `rules.${a.ruleId}-overdue` : `rules.${a.ruleId}`, {
        code: ltr(str(p.code)),
        party: str(p.party),
        date: formatDay(a.targetDate, locale),
      });
    case 'INVOICE-MONTH-END':
      return t(num(p.overdue) === 1 ? 'rules.INVOICE-MONTH-END-overdue' : 'rules.INVOICE-MONTH-END', {
        count: num(p.count),
        date: formatDay(a.targetDate, locale),
      });
    case 'DAY-CONFLICT':
      return t('rules.DAY-CONFLICT', {
        date,
        count: num(p.count),
        factors: str(p.factors)
          .split(',')
          .map((f) => t(`rulesShort.${f}`))
          .join(', '),
      });
  }
}

export const kindsText = (t: T, kinds: readonly string[]): string =>
  kinds.map((k) => t(`option.kinds.${k}`)).join(' + ');

/** One line per thing the option touches (a pair has several). */
export function cashOptionLines(t: T, locale: string, option: CashOption): string[] {
  return option.refs.map((r) =>
    t(`option.line.${r.kind}`, {
      code: ltr(r.code),
      party: r.partyName,
      amount: moneyText(r.amount),
      date: r.to ? formatDay(r.to, locale) : '',
    }),
  );
}

export function collectLine(t: T, option: InformationalOption): string {
  return t('option.line.COLLECT-OVERDUE', {
    party: option.partyName,
    amount: moneyText(option.potential),
    count: option.items.length,
  });
}

export function stockOptionLines(t: T, locale: string, option: StockOption): string[] {
  if (option.draft) {
    return [
      t('option.line.EMERGENCY-PURCHASE', {
        qty: milliText(option.draft.qtyMilli),
        unit: option.draft.unitLabel,
        party: option.draft.supplierName,
        amount: option.cashImpact === null ? '—' : moneyText(option.cashImpact),
        date: option.draft.dueDate ? formatDay(option.draft.dueDate, locale) : '—',
      }),
    ];
  }
  if (option.split) {
    return [
      t('option.line.SPLIT-DELIVERY', {
        order: ltr(option.split.orderCode),
        client: ltr(option.split.clientCode),
        m3: m3Text(option.split.movedL),
        from: formatDay(option.split.fromDate, locale),
        to: formatDay(option.split.toDate, locale),
      }),
    ];
  }
  return [];
}
