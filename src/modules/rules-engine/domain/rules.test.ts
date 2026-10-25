import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { NO_HOLIDAYS } from './calendar';
import { forecastCash } from './forecast';
import {
  alertKey,
  dayConflicts,
  evaluateRules,
  RULE_CATALOGUE,
  RULES,
  type RuleHit,
  type RuleId,
  type RulesInput,
  sortAlerts,
} from './rules';
import { projectStock } from './stock-risk';
import type { CashFlow, OverdueReceivable } from './types';

const flow = (over: Partial<CashFlow> & { id: string }): CashFlow => ({
  direction: 'in',
  amount: centimes(100),
  baseDate: '2026-11-04',
  worstDate: over.baseDate ?? '2026-11-04',
  certainty: 'probable',
  source: 'plan',
  method: 'cheque',
  instrumentState: null,
  ref: { type: 'order', id: 'o', code: 'CMD-1' },
  partyId: 'p',
  partyName: 'Party',
  earlyPresentable: false,
  ...over,
});

const emptyStock = projectStock({
  today: '2026-11-02',
  horizonDays: 5,
  calendar: NO_HOLIDAYS,
  components: [],
  demands: [],
  recettes: new Map(),
  receipts: [],
});

function base(over: Partial<RulesInput> = {}, flows: CashFlow[] = []): RulesInput {
  const input = {
    today: '2026-11-02',
    leadDays: 2,
    legalReminderDays: 7,
    bounceReminderDays: [20, 27],
    threshold: centimes(0),
    flows,
    overdue: [] as OverdueReceivable[],
    bounced: [],
    stock: emptyStock,
    deadlines: [],
    ...over,
  };
  return {
    ...input,
    forecast: forecastCash({
      today: input.today,
      horizonDays: 5,
      encaisse: centimes(1_000),
      threshold: input.threshold,
      flows: input.flows,
      calendar: NO_HOLIDAYS,
    }),
  };
}

const shortStock = projectStock({
  today: '2026-11-02',
  horizonDays: 5,
  calendar: NO_HOLIDAYS,
  components: [
    { id: 'cem', nameFr: 'Ciment', nameAr: 'إسمنت', baseUnit: 'g', level: 1_000_000, lowThreshold: 500_000 },
    { id: 'sand', nameFr: 'Sable', nameAr: 'رمل', baseUnit: 'g', level: 9_000_000, lowThreshold: 7_000_000 },
  ],
  demands: [
    {
      orderId: '1',
      orderCode: 'CMD-1',
      clientCode: 'CLT-1',
      typeId: 't',
      typeLabel: 'B25',
      date: '2026-11-04',
      volumeL: 10_000,
    },
  ],
  recettes: new Map([
    [
      't',
      [
        {
          effectiveFrom: '2026-01-01',
          lines: [
            { componentId: 'cem', qtyPerM3: 350_000 },
            { componentId: 'sand', qtyPerM3: 300_000 },
          ],
        },
      ],
    ],
  ]),
  receipts: [],
});

const ids = (hits: RuleHit[]) => hits.map(alertKey);

describe('rules catalogue: every rule fires when it should and stays quiet when it should not (AC-RE-06)', () => {
  it('lists every rule as a function, except the conflict that groups them', () => {
    expect(Object.keys(RULES).sort()).toEqual(RULE_CATALOGUE.filter((r) => r !== 'DAY-CONFLICT').sort());
  });

  describe('CASH-DEFICIT', () => {
    const deficit = [flow({ id: 'out', direction: 'out', amount: centimes(1_600), baseDate: '2026-11-04' })];
    it('fires as a risk on the first deficit day of the normal forecast', () => {
      const hits = RULES['CASH-DEFICIT'](base({}, deficit));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ severity: 'risk', targetDate: '2026-11-04', subjectKey: '2026-11-04' });
      expect(hits[0]?.params).toMatchObject({ balance: -600, shortfall: 600 });
      expect(hits[0]?.causes.map((c) => c.flowId)).toEqual(['out']);
    });
    it('does not fire when the balance stays at or above the threshold, and follows the threshold (AC-RE-04)', () => {
      expect(
        RULES['CASH-DEFICIT'](
          base({}, [flow({ id: 'o', direction: 'out', amount: centimes(1_000), baseDate: '2026-11-04' })]),
        ),
      ).toEqual([]);
      expect(RULES['CASH-DEFICIT'](base({ threshold: centimes(50_000) }, []))).toHaveLength(1);
    });
    it('does not fire for a worst-case-only deficit (AC-RE-13)', () => {
      const worstOnly = [
        flow({ id: 'in', amount: centimes(1_000), baseDate: '2026-11-03' }),
        flow({
          id: 'chq',
          direction: 'out',
          amount: centimes(1_500),
          baseDate: '2026-11-06',
          worstDate: '2026-11-02',
          earlyPresentable: true,
        }),
      ];
      expect(RULES['CASH-DEFICIT'](base({}, worstOnly))).toEqual([]);
    });
  });

  describe('CASH-DEFICIT-WORST', () => {
    const worstOnly = [
      flow({ id: 'in', amount: centimes(1_000), baseDate: '2026-11-03' }),
      flow({
        id: 'chq',
        direction: 'out',
        amount: centimes(1_500),
        baseDate: '2026-11-06',
        worstDate: '2026-11-02',
        earlyPresentable: true,
      }),
    ];
    it('fires as urgent when only the worst case breaks the threshold', () => {
      const hits = RULES['CASH-DEFICIT-WORST'](base({}, worstOnly));
      expect(hits[0]).toMatchObject({ severity: 'urgent', targetDate: '2026-11-02' });
      expect(hits[0]?.causes.map((c) => c.flowId)).toEqual(['chq']);
    });
    it('does not fire when the worst case is fine', () => {
      expect(RULES['CASH-DEFICIT-WORST'](base({}, []))).toEqual([]);
    });
  });

  describe('PAY-DUE', () => {
    it('fires exactly from two days before the due date, as urgent (AC-RE-05)', () => {
      const out = (date: string) => [
        flow({
          id: 'o',
          direction: 'out',
          baseDate: date,
          ref: { type: 'purchase', id: 'p', code: 'ACH-1' },
        }),
      ];
      expect(RULES['PAY-DUE'](base({}, out('2026-11-04')))[0]).toMatchObject({
        severity: 'urgent',
        subjectKey: 'o',
      });
      expect(RULES['PAY-DUE'](base({}, out('2026-11-05')))).toEqual([]);
    });
    it('also covers an overdue payable, owed today', () => {
      expect(
        RULES['PAY-DUE'](base({}, [flow({ id: 'o', direction: 'out', baseDate: '2026-11-02' })])),
      ).toHaveLength(1);
    });
    it('is not raised for what we receive', () => {
      expect(RULES['PAY-DUE'](base({}, [flow({ id: 'i', baseDate: '2026-11-03' })]))).toEqual([]);
    });
  });

  describe('RCV-DUE', () => {
    it('is probable, for incoming plan items due within two days', () => {
      const hits = RULES['RCV-DUE'](base({}, [flow({ id: 'i', baseDate: '2026-11-03' })]));
      expect(hits[0]).toMatchObject({ severity: 'probable' });
    });
    it('ignores later items, outgoing flows and instruments', () => {
      expect(
        RULES['RCV-DUE'](
          base({}, [
            flow({ id: 'far', baseDate: '2026-11-09' }),
            flow({ id: 'out', direction: 'out', baseDate: '2026-11-03' }),
            flow({ id: 'chq', baseDate: '2026-11-03', source: 'instrument' }),
          ]),
        ),
      ).toEqual([]);
    });
  });

  describe('RCV-OVERDUE', () => {
    const late: OverdueReceivable = {
      id: 'late',
      documentId: 'o',
      documentCode: 'CMD-9',
      partyId: 'c',
      partyName: 'Client',
      dueDate: '2026-10-20',
      daysLate: 13,
      amount: centimes(5_000),
    };
    it('is urgent (the account colour is the red one, not the alert: A15)', () => {
      expect(RULES['RCV-OVERDUE'](base({ overdue: [late] }))[0]).toMatchObject({
        severity: 'urgent',
        targetDate: '2026-10-20',
      });
    });
    it('is quiet with nothing overdue', () => {
      expect(RULES['RCV-OVERDUE'](base())).toEqual([]);
    });
  });

  describe('CHQ-BOUNCED (AC-RE-03)', () => {
    const bounced = (bouncedOn: string) => ({
      id: 'b',
      label: 'CH 7 · BMCE',
      amount: centimes(40_000),
      partyName: 'Client',
      bouncedOn,
      deadline: '2026-11-25',
    });
    it('is a risk with the days left in the 30-day window', () => {
      const [h] = RULES['CHQ-BOUNCED'](base({ bounced: [bounced('2026-10-26')] }));
      expect(h).toMatchObject({ severity: 'risk', targetDate: '2026-11-25' });
      expect(h?.params).toMatchObject({ daysLeft: 23, windowDays: 30, reminder: null });
    });
    it('reminds at day 20 and day 27 of the window', () => {
      expect(RULES['CHQ-BOUNCED'](base({ bounced: [bounced('2026-10-13')] }))[0]?.params.reminder).toBe(
        'day20',
      );
      expect(RULES['CHQ-BOUNCED'](base({ bounced: [bounced('2026-10-05')] }))[0]?.params.reminder).toBe(
        'day27',
      );
    });
    it('escalates once the window is over', () => {
      const [h] = RULES['CHQ-BOUNCED'](base({ today: '2026-11-27', bounced: [bounced('2026-10-26')] }));
      expect(h?.params).toMatchObject({ reminder: 'expired', daysLeft: -2 });
    });
    it('is quiet without a bounced cheque', () => {
      expect(RULES['CHQ-BOUNCED'](base())).toEqual([]);
    });
  });

  describe('STOCK-SHORTAGE and STOCK-LOW', () => {
    it('a negative projected level is a risk, a level under the threshold is urgent', () => {
      const shortage = RULES['STOCK-SHORTAGE'](base({ stock: shortStock }));
      expect(shortage).toHaveLength(1);
      expect(shortage[0]).toMatchObject({
        severity: 'risk',
        targetDate: '2026-11-04',
        subjectKey: 'cem:2026-11-04',
      });
      const low = RULES['STOCK-LOW'](base({ stock: shortStock }));
      expect(low).toHaveLength(1);
      expect(low[0]).toMatchObject({ severity: 'urgent', subjectKey: 'sand:2026-11-04' });
    });
    it('are quiet when stock holds', () => {
      expect(RULES['STOCK-SHORTAGE'](base())).toEqual([]);
      expect(RULES['STOCK-LOW'](base())).toEqual([]);
    });
  });

  describe('LAW6921-RECEIVABLE and LAW6921-PAYABLE', () => {
    const d = (kind: 'receivable_due' | 'payable_due', date: string) => ({
      kind,
      date,
      documentCode: 'X-1',
      partyName: 'Party',
      amountCentimes: 1_000,
    });
    it('a receivable due within a week is probable, overdue is urgent', () => {
      expect(
        RULES['LAW6921-RECEIVABLE'](base({ deadlines: [d('receivable_due', '2026-11-08')] }))[0]?.severity,
      ).toBe('probable');
      expect(
        RULES['LAW6921-RECEIVABLE'](base({ deadlines: [d('receivable_due', '2026-10-30')] }))[0]?.severity,
      ).toBe('urgent');
      expect(RULES['LAW6921-RECEIVABLE'](base({ deadlines: [d('receivable_due', '2026-11-20')] }))).toEqual(
        [],
      );
    });
    it('a payable due within a week is important, within two days or overdue urgent', () => {
      expect(
        RULES['LAW6921-PAYABLE'](base({ deadlines: [d('payable_due', '2026-11-08')] }))[0]?.severity,
      ).toBe('important');
      expect(
        RULES['LAW6921-PAYABLE'](base({ deadlines: [d('payable_due', '2026-11-04')] }))[0]?.severity,
      ).toBe('urgent');
      expect(RULES['LAW6921-PAYABLE'](base({ deadlines: [d('payable_due', '2026-11-30')] }))).toEqual([]);
      expect(RULES['LAW6921-PAYABLE'](base({ deadlines: [d('receivable_due', '2026-11-03')] }))).toEqual([]);
    });
  });

  describe('INVOICE-MONTH-END', () => {
    const issue = (date: string, code: string) => ({
      kind: 'invoice_to_issue' as const,
      date,
      documentCode: code,
      partyName: 'C',
      amountCentimes: null,
    });
    it('groups the invoices still to issue by month end, three days ahead or already late', () => {
      const hits = RULES['INVOICE-MONTH-END'](
        base({
          today: '2026-11-28',
          deadlines: [issue('2026-11-30', 'A'), issue('2026-11-30', 'B'), issue('2026-10-31', 'C')],
        }),
      );
      expect(hits.map((h) => [h.subjectKey, h.params.count, h.params.overdue])).toEqual([
        ['2026-10-31', 1, 1],
        ['2026-11-30', 2, 0],
      ]);
    });
    it('is quiet earlier in the month', () => {
      expect(RULES['INVOICE-MONTH-END'](base({ deadlines: [issue('2026-11-30', 'A')] }))).toEqual([]);
    });
  });
});

describe('DAY-CONFLICT', () => {
  const outFlows = [
    flow({
      id: 'o',
      direction: 'out',
      amount: centimes(1_600),
      baseDate: '2026-11-04',
      ref: { type: 'purchase', id: 'p', code: 'ACH-1' },
    }),
  ];
  it('groups two different kinds of problem on the same date into one risk, keeping the children', () => {
    const hits = evaluateRules(base({ stock: shortStock }, outFlows));
    const conflict = hits.find((h) => h.ruleId === 'DAY-CONFLICT');
    expect(conflict).toMatchObject({ severity: 'risk', targetDate: '2026-11-04' });
    expect(conflict?.params.factors).toBe('CASH-DEFICIT,PAY-DUE,STOCK-SHORTAGE');
    expect(conflict?.childKeys).toEqual([
      'CASH-DEFICIT:2026-11-04',
      'PAY-DUE:o',
      'STOCK-SHORTAGE:cem:2026-11-04',
    ]);
    expect(ids(hits)).toContain('CASH-DEFICIT:2026-11-04');
  });
  it('is not raised for one kind of problem, nor for problems on different dates', () => {
    expect(
      dayConflicts(
        evaluateRules(
          base({}, [flow({ id: 'o', direction: 'out', amount: centimes(1_600), baseDate: '2026-11-06' })]),
        ),
      ),
    ).toEqual([]);
    expect(
      dayConflicts(evaluateRules(base({ stock: shortStock })).filter((h) => h.ruleId === 'STOCK-SHORTAGE')),
    ).toEqual([]);
  });
});

describe('evaluateRules and the list order', () => {
  it('is deterministic whatever the order of the flows (AC-RE-01)', () => {
    const flows = [
      flow({ id: 'a', direction: 'out', amount: centimes(900), baseDate: '2026-11-03' }),
      flow({ id: 'b', direction: 'out', amount: centimes(900), baseDate: '2026-11-03' }),
      flow({ id: 'c', baseDate: '2026-11-03' }),
    ];
    const one = evaluateRules(base({ stock: shortStock }, flows));
    const two = evaluateRules(base({ stock: shortStock }, [...flows].reverse()));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('puts conflicts first, then the worst severity, then the date', () => {
    const mk = (ruleId: RuleId, severity: RuleHit['severity'], targetDate: string) => ({
      ruleId,
      subjectKey: targetDate,
      severity,
      targetDate,
    });
    const sorted = sortAlerts([
      mk('RCV-DUE', 'probable', '2026-11-03'),
      mk('STOCK-LOW', 'urgent', '2026-11-09'),
      mk('CASH-DEFICIT', 'risk', '2026-11-08'),
      mk('DAY-CONFLICT', 'risk', '2026-11-20'),
      mk('PAY-DUE', 'urgent', '2026-11-04'),
    ]);
    expect(sorted.map((a) => a.ruleId)).toEqual([
      'DAY-CONFLICT',
      'CASH-DEFICIT',
      'PAY-DUE',
      'STOCK-LOW',
      'RCV-DUE',
    ]);
  });
});
