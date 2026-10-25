import { type Centimes, centimes, subCentimes } from '@/lib/money';
import type { CashOption, InformationalOption } from './options';
import type { StockOption } from './stock-options';

/**
 * What a draft message is about, as data. The words are composed by the screen from the messages files, in the owner's
 * language; the engine only says who, which document, how much and by when. The owner sends it himself: the application
 * sends nothing (DECISIONS 59, A23).
 */
export type DraftSpec =
  | { type: 'postpone'; party: string; code: string; amount: Centimes; newDate: string }
  | { type: 'advance'; party: string; code: string; amount: Centimes; byDate: string }
  | { type: 'discount'; party: string; code: string; amount: Centimes; fee: Centimes; byDate: string }
  | { type: 'deposit'; party: string; code: string; amount: Centimes; date: string }
  | {
      type: 'reminder';
      party: string;
      total: Centimes;
      items: { code: string; amount: Centimes; dueDate: string }[];
    }
  | { type: 'split'; party: string; code: string; fromDate: string; toDate: string; movedL: number }
  | {
      type: 'purchase';
      party: string;
      unit: string;
      qtyMilli: number;
      estimatedHt: Centimes | null;
      dueDate: string | null;
    };

export function draftsOfCashOption(option: CashOption): DraftSpec[] {
  const feeOf = (ref: CashOption['refs'][number]): Centimes => {
    const change = option.changes.find(
      (c) => c.type === 'replace' && c.to === ref.to && c.flowId === `instrument:${ref.id}`,
    );
    return change && change.type === 'replace' ? subCentimes(ref.amount, change.amount) : centimes(0);
  };
  return option.refs.map<DraftSpec>((r) => {
    const to = r.to ?? '';
    switch (r.kind) {
      case 'POSTPONE-PAYABLE':
        return { type: 'postpone', party: r.partyName, code: r.code, amount: r.amount, newDate: to };
      case 'REQUEST-ADVANCE':
        return { type: 'advance', party: r.partyName, code: r.code, amount: r.amount, byDate: to };
      case 'DISCOUNT':
        return {
          type: 'discount',
          party: r.partyName,
          code: r.code,
          amount: r.amount,
          fee: feeOf(r),
          byDate: to,
        };
      default:
        return { type: 'deposit', party: r.partyName, code: r.code, amount: r.amount, date: to };
    }
  });
}

export function draftOfCollect(option: InformationalOption): DraftSpec {
  return {
    type: 'reminder',
    party: option.partyName,
    total: option.potential,
    items: option.items.map((i) => ({ code: i.code, amount: i.amount, dueDate: i.dueDate })),
  };
}

export function draftsOfStockOption(option: StockOption): DraftSpec[] {
  if (option.kind === 'EMERGENCY-PURCHASE' && option.draft) {
    return [
      {
        type: 'purchase',
        party: option.draft.supplierName,
        unit: option.draft.unitLabel,
        qtyMilli: option.draft.qtyMilli,
        estimatedHt: option.draft.estimatedHtCentimes,
        dueDate: option.draft.dueDate,
      },
    ];
  }
  if (option.split) {
    return [
      {
        type: 'split',
        party: option.split.clientCode,
        code: option.split.orderCode,
        fromDate: option.split.fromDate,
        toDate: option.split.toDate,
        movedL: option.split.movedL,
      },
    ];
  }
  return [];
}
