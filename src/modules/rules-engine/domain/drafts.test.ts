import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { draftOfCollect, draftsOfCashOption, draftsOfStockOption } from './drafts';
import type { CashOption, InformationalOption } from './options';
import type { StockOption } from './stock-options';

const ref = (kind: CashOption['refs'][number]['kind'], over = {}) => ({
  kind,
  type: 'purchase' as const,
  id: 'x',
  code: 'ACH-1',
  partyId: 'p',
  partyName: 'FRN-05',
  amount: centimes(8_500_000),
  to: '2026-11-10',
  ...over,
});
const option = (refs: CashOption['refs'], changes: CashOption['changes'] = []) =>
  ({ refs, changes }) as unknown as CashOption;

describe('drafts', () => {
  it('turns each reference of a cash option into the draft of its kind, as data', () => {
    const drafts = draftsOfCashOption(
      option(
        [
          ref('POSTPONE-PAYABLE'),
          ref('REQUEST-ADVANCE', {
            type: 'order',
            code: 'CMD-1',
            partyName: 'CLT-17',
            amount: centimes(3_369_600),
            to: '2026-11-05',
          }),
          ref('DEPOSIT-EARLY', { type: 'instrument', code: 'CH 88', to: '2026-11-04' }),
          ref('DISCOUNT', { type: 'instrument', id: 'lcn', code: 'LCN 5', to: '2026-11-04' }),
        ],
        [{ type: 'replace', flowId: 'instrument:lcn', amount: centimes(8_400_000), to: '2026-11-04' }],
      ),
    );
    expect(drafts.map((d) => d.type)).toEqual(['postpone', 'advance', 'deposit', 'discount']);
    expect(drafts[0]).toMatchObject({ party: 'FRN-05', newDate: '2026-11-10', amount: 8_500_000 });
    expect(drafts[3]).toMatchObject({ fee: 100_000 });
  });

  it('a discount without its change has no fee, a reference without a date has an empty one', () => {
    const [d] = draftsOfCashOption(option([ref('DISCOUNT', { to: null })]));
    expect(d).toMatchObject({ type: 'discount', fee: 0, byDate: '' });
  });

  it('drafts the reminder of a collect option and the messages of the stock options', () => {
    const collect = {
      partyName: 'CLT-9',
      potential: centimes(300),
      items: [{ code: 'CMD-9', amount: centimes(300), dueDate: '2026-10-01' }],
    } as unknown as InformationalOption;
    expect(draftOfCollect(collect)).toMatchObject({
      type: 'reminder',
      total: 300,
      items: [{ code: 'CMD-9' }],
    });
    const purchase = {
      kind: 'EMERGENCY-PURCHASE',
      draft: {
        supplierName: 'F',
        unitLabel: 't',
        qtyMilli: 1700,
        estimatedHtCentimes: centimes(161_500),
        dueDate: '2026-12-02',
      },
      split: null,
    } as unknown as StockOption;
    expect(draftsOfStockOption(purchase)[0]).toMatchObject({ type: 'purchase', qtyMilli: 1700 });
    const split = {
      kind: 'SPLIT-DELIVERY',
      draft: null,
      split: {
        orderCode: 'CMD-1',
        clientCode: 'CLT-1',
        fromDate: '2026-11-04',
        toDate: '2026-11-05',
        movedL: 4000,
      },
    } as unknown as StockOption;
    expect(draftsOfStockOption(split)[0]).toMatchObject({ type: 'split', movedL: 4000 });
    expect(
      draftsOfStockOption({ kind: 'SPLIT-DELIVERY', draft: null, split: null } as unknown as StockOption),
    ).toEqual([]);
  });
});
