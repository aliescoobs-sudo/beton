import { describe, expect, it } from 'vitest';
import { USER_ROLES } from '@/modules/platform-security/domain/permissions';
import { type Effect, isMoneyEffect, visibleEffects } from './effects';

const all: Effect[] = [
  { kind: 'document', document: 'invoice', code: 'FA-2026-00001' },
  { kind: 'scheduled', code: 'CMD-2026-00001', date: '2026-11-02' },
  { kind: 'remaining', orderCode: 'CMD-2026-00001', remainingL: 2000 },
  {
    kind: 'stock',
    componentNameFr: 'Ciment',
    componentNameAr: 'إسمنت',
    baseUnit: 'g',
    deltaBase: -2_800_000,
    levelAfter: 10_000_000,
    status: 'ok',
  },
  { kind: 'receivable', clientCode: 'CLT-001', amountCentimes: 936_000 },
  { kind: 'payable', supplierCode: 'FRN-01', amountCentimes: 552_000 },
  { kind: 'payment_in', method: 'cheque', amountCentimes: 936_000, cleared: false },
  { kind: 'payment_out', method: 'transfer', amountCentimes: 552_000, cleared: true },
  { kind: 'receivable_covered', orderCode: 'CMD-2026-00001', amountCentimes: 100_000 },
];

describe('visibleEffects (AC-LED-26)', () => {
  it('office, partner and plant see no money fact: no amount anywhere in what is left', () => {
    for (const role of ['office', 'partner', 'plant'] as const) {
      const seen = visibleEffects(all, role);
      expect(
        seen.map((e) => e.kind),
        role,
      ).toEqual(['document', 'scheduled', 'remaining', 'stock']);
      expect(JSON.stringify(seen), role).not.toMatch(/amountCentimes|936000|552000/);
    }
  });
  it('owner and support see everything', () => {
    for (const role of ['owner', 'support'] as const) expect(visibleEffects(all, role)).toEqual(all);
  });
  it('every role gets an answer and the money kinds are exactly the five money facts', () => {
    for (const role of USER_ROLES) expect(visibleEffects(all, role).length).toBeGreaterThan(0);
    expect(all.filter(isMoneyEffect)).toHaveLength(5);
  });
});
