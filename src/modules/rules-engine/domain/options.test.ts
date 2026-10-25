import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { NO_HOLIDAYS } from './calendar';
import { collectOptions, discountFee, generateCashOptions, type OptionParams, rankOptions } from './options';
import type { CashFlow, OverdueReceivable } from './types';
import { applyChanges, type Change } from './what-if';

const flow = (over: Partial<CashFlow> & { id: string }): CashFlow => ({
  direction: 'in',
  amount: centimes(100),
  baseDate: '2026-11-10',
  worstDate: over.baseDate ?? '2026-11-10',
  certainty: 'probable',
  source: 'plan',
  method: 'cheque',
  instrumentState: null,
  ref: { type: 'order', id: `ref-${over.id}`, code: `CODE-${over.id}` },
  partyId: `party-${over.id}`,
  partyName: `Party ${over.id}`,
  earlyPresentable: false,
  ...over,
});

const params: OptionParams = {
  today: '2026-11-03',
  calendar: NO_HOLIDAYS,
  horizonDays: 10,
  encaisse: centimes(2_000_000),
  threshold: centimes(0),
  clearingDelayDays: 1,
  postponeWorkingDays: 4,
  advanceExtraBp: 3_000,
  discountRateBp: 800,
};

const opt = (over: Partial<ReturnType<typeof rankOptions>[number]> & { id: string }) =>
  ({
    kind: ['POSTPONE-PAYABLE'],
    changes: [],
    refs: [],
    counterparties: [],
    gain: centimes(0),
    coverageBp: 0,
    full: false,
    surplus: centimes(0),
    newBalance: centimes(0),
    lowestAfter: null,
    newDeficitDates: [],
    remainingDeficitDates: [],
    createsNewRisk: false,
    cost: centimes(0),
    presentsPostDated: false,
    apply: null,
    ...over,
  }) as ReturnType<typeof rankOptions>[number];

// The black-day fixture, shaped like AC-RE-09: a deficit of 79 536,00 on D5, a stock shortage that costs 43 500,00 more
// (123 036,00 in all), and the three ways out the specification ranks.
const D5 = '2026-11-05';
const frn05 = flow({
  id: 'frn05',
  direction: 'out',
  amount: centimes(8_500_000),
  baseDate: D5,
  ref: { type: 'purchase', id: 'ach-05', code: 'ACH-2026-00005' },
  partyId: 'FRN-05',
  partyName: 'FRN-05',
  certainty: 'committed',
});
const issuedCheque = flow({
  id: 'chq-out',
  direction: 'out',
  amount: centimes(1_453_600),
  baseDate: D5,
  source: 'instrument',
  instrumentState: 'issued',
  ref: { type: 'instrument', id: 'chq-out', code: 'CH 12' },
  partyId: 'FRN-09',
  partyName: 'FRN-09',
  certainty: 'committed',
});
const chequeInHand = flow({
  id: 'chq-in',
  amount: centimes(13_500_000),
  baseDate: '2026-11-10',
  source: 'instrument',
  instrumentState: 'received',
  ref: { type: 'instrument', id: 'chq-in', code: 'CH 88' },
  partyId: 'CLT-03',
  partyName: 'CLT-03',
});
const clt17 = flow({
  id: 'clt17',
  amount: centimes(8_985_600),
  baseDate: '2026-11-12',
  ref: { type: 'order', id: 'cmd-17', code: 'CMD-2026-00017' },
  partyId: 'CLT-17',
  partyName: 'CLT-17',
  orderTotal: centimes(11_232_000),
  deliveryDate: D5,
});
const emergency: Change = {
  type: 'add',
  flow: flow({
    id: 'emergency',
    direction: 'out',
    amount: centimes(4_350_000),
    baseDate: D5,
    ref: { type: 'purchase', id: 'draft', code: 'draft' },
    partyId: 'FRN-01',
    partyName: 'FRN-01',
    draft: true,
  }),
};
const flows = [frn05, issuedCheque, chequeInHand, clt17];

describe('generateCashOptions on the black-day fixture (AC-RE-09)', () => {
  const result = generateCashOptions(flows, [], D5, params, [emergency]);

  it('measures the deficit before and after the stock cost', () => {
    expect(generateCashOptions(flows, [], D5, params).shortfall).toBe(7_953_600);
    expect(result.balance).toBe(-12_303_600);
    expect(result.shortfall).toBe(12_303_600);
  });

  it('ranks exactly: early deposit, then postpone + advance, then postpone alone', () => {
    expect(result.ranked.map((o) => o.id)).toEqual([
      'DEPOSIT-EARLY:chq-in',
      'POSTPONE-PAYABLE:frn05&REQUEST-ADVANCE:cmd-17',
      'POSTPONE-PAYABLE:frn05',
    ]);
  });

  it('computes the gain and the coverage by integer arithmetic', () => {
    const [deposit, pair, single] = result.ranked;
    expect(deposit).toMatchObject({ gain: 13_500_000, coverageBp: 10_000, full: true, surplus: 1_196_400 });
    expect(pair).toMatchObject({ gain: 11_869_600, coverageBp: 9_647, full: false });
    expect(single).toMatchObject({ gain: 8_500_000, coverageBp: 6_909 });
  });

  it('lists the counterparties and flags the post-dated cheque presented early', () => {
    const [deposit, pair] = result.ranked;
    expect(deposit?.counterparties.map((c) => c.id)).toEqual(['CLT-03']);
    expect(deposit?.presentsPostDated).toBe(true);
    expect(deposit?.apply).toEqual({
      type: 'deposit-instruments',
      instrumentIds: ['chq-in'],
      date: '2026-11-03',
    });
    expect(pair?.counterparties.map((c) => c.id)).toEqual(['CLT-17', 'FRN-05']);
    expect(pair?.apply).toBeNull();
  });

  it('creates no new deficit, and says where each option takes the money from and to', () => {
    expect(result.ranked.every((o) => !o.createsNewRisk)).toBe(true);
    expect(result.ranked[1]?.refs.map((r) => [r.code, r.amount, r.to])).toEqual([
      ['ACH-2026-00005', 8_500_000, '2026-11-10'],
      ['CMD-2026-00017', 3_369_600, D5],
    ]);
  });

  it('keeps the other options considered but not retained', () => {
    expect(result.others.map((o) => o.id)).toEqual(['REQUEST-ADVANCE:cmd-17']);
    expect(result.considered).toBe(4);
  });

  it('never writes or changes its inputs (AC-RE-10)', () => {
    const copy = JSON.stringify(flows);
    generateCashOptions(flows, [], D5, params, [emergency]);
    expect(JSON.stringify(flows)).toBe(copy);
  });

  it('is deterministic whatever the order of the flows (AC-RE-01)', () => {
    const again = generateCashOptions([...flows].reverse(), [], D5, params, [emergency]);
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });
});

describe('what each option does', () => {
  it('discounts an LCN with a fee instead of depositing it early', () => {
    const lcn = flow({
      id: 'lcn',
      method: 'lcn',
      amount: centimes(10_000_000),
      baseDate: '2026-12-01',
      source: 'instrument',
      instrumentState: 'received',
      ref: { type: 'instrument', id: 'lcn', code: 'LCN 5' },
      partyId: 'CLT-05',
      partyName: 'CLT-05',
    });
    const out = flow({
      id: 'o',
      direction: 'out',
      amount: centimes(9_000_000),
      baseDate: D5,
      ref: { type: 'purchase', id: 'p', code: 'ACH-1' },
      partyId: 'F',
      partyName: 'F',
    });
    const r = generateCashOptions([lcn, out], [], D5, params);
    const opt = r.ranked.find((o) => o.kind.includes('DISCOUNT'));
    // 27 days from 2026-11-04 to 2026-12-01 at 8 % a year: 10 000 000 × 800 × 27 / 3 650 000 = 59 178
    expect(discountFee(centimes(10_000_000), 800, 27)).toBe(59_178);
    expect(opt).toMatchObject({
      cost: 59_178,
      gain: 9_940_822,
      full: true,
      presentsPostDated: false,
      apply: null,
    });
    expect(r.ranked.some((o) => o.kind.includes('DEPOSIT-EARLY'))).toBe(false);
  });

  it('rounds the fee half away from zero and charges nothing for no days', () => {
    expect(discountFee(centimes(1), 800, 0)).toBe(0);
    expect(discountFee(centimes(100), 800, 1)).toBe(0);
    expect(discountFee(centimes(100_000), 800, 1)).toBe(22);
  });

  it('flags a postponement that only moves the deficit later, and ranks it below a clean one', () => {
    const f1 = flow({
      id: 'a',
      direction: 'out',
      amount: centimes(3_000_000),
      baseDate: D5,
      ref: { type: 'purchase', id: 'pa', code: 'ACH-A' },
      partyId: 'FA',
      partyName: 'FA',
    });
    const f2 = flow({
      id: 'b',
      direction: 'out',
      amount: centimes(1_900_000),
      baseDate: '2026-11-10',
      ref: { type: 'purchase', id: 'pb', code: 'ACH-B' },
      partyId: 'FB',
      partyName: 'FB',
    });
    const r = generateCashOptions([f1, f2], [], D5, params);
    const post = [...r.ranked, ...r.others].find((o) => o.id === 'POSTPONE-PAYABLE:a');
    expect(post).toMatchObject({ full: true, createsNewRisk: false });
    expect(post?.remainingDeficitDates).toContain('2026-11-10');
    // a complete option that only moves the deficit later is not as good as one that clears it
    const clean = opt({ id: 'z-clean', full: true, coverageBp: 10_000 });
    expect(rankOptions([post as never, clean]).map((o) => o.id)).toEqual(['z-clean', 'POSTPONE-PAYABLE:a']);
  });

  it('proposes nothing when the day is not in deficit', () => {
    const r = generateCashOptions([], [], D5, params);
    expect(r).toMatchObject({ shortfall: 0, ranked: [], others: [] });
  });

  it('does not offer an early deposit when the cheque could not clear by the target day', () => {
    const r = generateCashOptions(flows, [], D5, { ...params, clearingDelayDays: 5 }, [emergency]);
    expect([...r.ranked, ...r.others].some((o) => o.kind.includes('DEPOSIT-EARLY'))).toBe(false);
  });

  it('asks an advance only on an order delivered by the target day, never beyond what is still to come', () => {
    const late = { ...clt17, deliveryDate: '2026-11-20' };
    const none = generateCashOptions([frn05, late], [], D5, params);
    expect([...none.ranked, ...none.others].some((o) => o.kind.includes('REQUEST-ADVANCE'))).toBe(false);
    const small = { ...clt17, amount: centimes(1_000_000) };
    const capped = generateCashOptions([frn05, small], [], D5, params);
    const adv = [...capped.ranked, ...capped.others].find((o) => o.id === 'REQUEST-ADVANCE:cmd-17');
    expect(adv?.gain).toBe(1_000_000);
  });
});

describe('collect overdue (not counted until paid)', () => {
  const late = (id: string, party: string, amount: number, due: string): OverdueReceivable => ({
    id,
    documentId: `doc-${id}`,
    documentCode: `CMD-${id}`,
    partyId: party,
    partyName: party,
    dueDate: due,
    daysLate: 10,
    amount: centimes(amount),
  });

  it('groups per client, biggest first, and never changes the forecast', () => {
    const overdue = [
      late('1', 'A', 100, '2026-10-20'),
      late('2', 'B', 900, '2026-10-21'),
      late('3', 'A', 50, '2026-10-10'),
    ];
    const info = collectOptions(overdue);
    expect(info.map((i) => [i.partyId, i.potential])).toEqual([
      ['B', 900],
      ['A', 150],
    ]);
    expect(info[1]?.items.map((i) => i.id)).toEqual(['3', '1']);
    const r = generateCashOptions(flows, overdue, D5, params, [emergency]);
    expect(r.informational).toHaveLength(2);
    expect(r.ranked.every((o) => !o.kind.includes('COLLECT-OVERDUE'))).toBe(true);
    expect(r.ranked[0]?.gain).toBe(13_500_000);
  });
});

describe('ranking and what-if', () => {
  const cp = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `c${i}` }));

  it('puts clean full options first, fewer counterparties then smaller surplus', () => {
    const ranked = rankOptions([
      opt({ id: 'z-partial', coverageBp: 9_000 }),
      opt({ id: 'b-full-2', full: true, coverageBp: 10_000, counterparties: cp(2), surplus: centimes(1) }),
      opt({
        id: 'c-full-1-big',
        full: true,
        coverageBp: 10_000,
        counterparties: cp(1),
        surplus: centimes(900),
      }),
      opt({
        id: 'a-full-1-small',
        full: true,
        coverageBp: 10_000,
        counterparties: cp(1),
        surplus: centimes(10),
      }),
      opt({ id: 'd-full-risky', full: true, coverageBp: 10_000, createsNewRisk: true }),
    ]);
    expect(ranked.map((o) => o.id)).toEqual([
      'a-full-1-small',
      'c-full-1-big',
      'b-full-2',
      'd-full-risky',
      'z-partial',
    ]);
  });

  it('ranks partial options by coverage, ties by id', () => {
    const ranked = rankOptions([
      opt({ id: 'b', coverageBp: 5_000 }),
      opt({ id: 'a', coverageBp: 5_000 }),
      opt({ id: 'c', coverageBp: 8_000 }),
    ]);
    expect(ranked.map((o) => o.id)).toEqual(['c', 'a', 'b']);
  });

  it('applyChanges moves, replaces and splits flows without touching the original list, and ignores unknown ids', () => {
    const list = [flow({ id: 'x', amount: centimes(1_000), baseDate: '2026-11-10' })];
    const moved = applyChanges(list, [
      { type: 'move', flowId: 'x', to: '2026-11-04' },
      { type: 'move', flowId: 'nope', to: '2026-11-01' },
    ]);
    expect(moved[0]).toMatchObject({ baseDate: '2026-11-04', worstDate: '2026-11-04' });
    const replaced = applyChanges(list, [
      { type: 'replace', flowId: 'x', amount: centimes(900), to: '2026-11-04' },
    ]);
    expect(replaced[0]).toMatchObject({ amount: 900, baseDate: '2026-11-04' });
    const split = applyChanges(list, [
      { type: 'split', flowId: 'x', amount: centimes(400), to: '2026-11-04' },
    ]);
    expect(split.map((f) => [f.id, f.amount, f.baseDate])).toEqual([
      ['x~2026-11-04', 400, '2026-11-04'],
      ['x', 600, '2026-11-10'],
    ]);
    const whole = applyChanges(list, [
      { type: 'split', flowId: 'x', amount: centimes(1_000), to: '2026-11-04' },
    ]);
    expect(whole).toHaveLength(1);
    const over = applyChanges(list, [
      { type: 'split', flowId: 'x', amount: centimes(2_000), to: '2026-11-04' },
    ]);
    expect(over[0]?.amount).toBe(1_000);
    expect(list[0]).toMatchObject({ amount: 1_000, baseDate: '2026-11-10' });
  });
});
