import { describe, expect, it } from 'vitest';
import { parseQuoteInput, quoteIsOpen, quoteValidUntil } from './quote';

const id = '0192f3a0-0000-7000-8000-000000000001';

describe('quote domain (AC-LED-23)', () => {
  it('accepts a client, a type and a volume; a validity is optional and bounded', () => {
    expect(parseQuoteInput({ clientId: id, concreteTypeId: id, volumeL: 8000 }).ok).toBe(true);
    expect(parseQuoteInput({ clientId: id, concreteTypeId: id, volumeL: 8000, validDays: 15 }).ok).toBe(true);
    expect(parseQuoteInput({ clientId: id, concreteTypeId: id, volumeL: 0 }).ok).toBe(false);
    expect(parseQuoteInput({ clientId: id, concreteTypeId: id, volumeL: 8000, validDays: 400 }).ok).toBe(
      false,
    );
    expect(parseQuoteInput({ clientId: 'x', concreteTypeId: id, volumeL: 8000 }).ok).toBe(false);
  });
  it('is valid 30 days by default', () => {
    expect(quoteValidUntil('2026-10-24')).toBe('2026-11-23');
    expect(quoteValidUntil('2026-10-24', 10)).toBe('2026-11-03');
  });
  it('is open until its last day, and only while no order points at it', () => {
    expect(quoteIsOpen({ validUntil: '2026-11-23', convertedOrderCode: null }, '2026-11-23')).toBe(true);
    expect(quoteIsOpen({ validUntil: '2026-11-23', convertedOrderCode: null }, '2026-11-24')).toBe(false);
    expect(
      quoteIsOpen({ validUntil: '2026-11-23', convertedOrderCode: 'CMD-2026-00001' }, '2026-11-01'),
    ).toBe(false);
  });
});
