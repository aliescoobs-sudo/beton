import { describe, expect, it } from 'vitest';
import {
  parseListPriceInput,
  parseOverrideInput,
  resolveSellingPrice,
  type SellingPrice,
} from './selling-price';

const price = (
  id: string,
  clientId: string | null,
  effectiveFrom: string,
  priceHtPerM3Centimes: number,
  typeId = 'B25',
  plantId: string | null = null,
): SellingPrice => ({
  id,
  concreteTypeId: typeId,
  clientId,
  plantId,
  priceHtPerM3Centimes,
  effectiveFrom,
  reason: clientId ? 'accord' : null,
});

describe('resolveSellingPrice (AC-MD-03)', () => {
  const versions = [
    price('l1', null, '2026-01-01', 90_000),
    price('l2', null, '2026-06-01', 95_000),
    price('o1', 'c1', '2026-03-01', 80_000),
    price('other-type', null, '2026-01-01', 1, 'B30'),
  ];

  it('the client override beats the list price, even when the list price is newer', () => {
    expect(resolveSellingPrice(versions, 'B25', 'c1', '2026-07-01')).toMatchObject({
      ok: true,
      value: { id: 'o1', priceHtPerM3Centimes: 80_000 },
    });
  });

  it('falls back to the list price before the override starts and for other clients', () => {
    expect(resolveSellingPrice(versions, 'B25', 'c1', '2026-02-28')).toMatchObject({ value: { id: 'l1' } });
    expect(resolveSellingPrice(versions, 'B25', 'c2', '2026-07-01')).toMatchObject({ value: { id: 'l2' } });
    expect(resolveSellingPrice(versions, 'B25', null, '2026-07-01')).toMatchObject({ value: { id: 'l2' } });
  });

  it('uses the version in force on the date (versioning by effective_from)', () => {
    expect(resolveSellingPrice(versions, 'B25', null, '2026-05-31')).toMatchObject({ value: { id: 'l1' } });
    expect(resolveSellingPrice(versions, 'B25', null, '2026-06-01')).toMatchObject({ value: { id: 'l2' } });
  });

  it('returns NO_PRICE, never 0, when nothing applies', () => {
    expect(resolveSellingPrice(versions, 'B25', 'c1', '2025-12-31')).toEqual({
      ok: false,
      error: 'NO_PRICE',
    });
    expect(resolveSellingPrice([], 'B25', null, '2026-01-01')).toEqual({ ok: false, error: 'NO_PRICE' });
    expect(resolveSellingPrice(versions, 'B20', 'c1', '2026-07-01')).toEqual({
      ok: false,
      error: 'NO_PRICE',
    });
  });
});

describe('parseListPriceInput', () => {
  const valid = {
    concreteTypeId: '019c0000-0000-7000-8000-000000000001',
    priceHtPerM3Centimes: 95_000,
    effectiveFrom: '2026-01-01',
  };
  it('accepts integer centimes and a real date', () => {
    expect(parseListPriceInput(valid).ok).toBe(true);
  });
  it.each([
    ['a fractional price', { ...valid, priceHtPerM3Centimes: 950.5 }],
    ['a zero price', { ...valid, priceHtPerM3Centimes: 0 }],
    ['an impossible date', { ...valid, effectiveFrom: '2026-13-01' }],
    ['no type', { ...valid, concreteTypeId: 'x' }],
  ])('refuses %s', (_name, input) => {
    expect(parseListPriceInput(input)).toEqual({ ok: false, error: 'INVALID' });
  });
});

describe('parseOverrideInput (AC-MD-10)', () => {
  const valid = {
    concreteTypeId: '019c0000-0000-7000-8000-000000000001',
    clientId: '019c0000-0000-7000-8000-000000000002',
    priceHtPerM3Centimes: 85_000,
    effectiveFrom: '2026-01-01',
    reason: '  Gros  chantier  ',
  };
  it('keeps a trimmed, single-spaced reason', () => {
    expect(parseOverrideInput(valid)).toMatchObject({ ok: true, value: { reason: 'Gros chantier' } });
  });
  it.each([
    ['no reason', { ...valid, reason: undefined }],
    ['an empty reason', { ...valid, reason: '' }],
    ['a blank reason', { ...valid, reason: '   ' }],
    ['a reason over 500 characters', { ...valid, reason: 'x'.repeat(501) }],
    ['no client', { ...valid, clientId: undefined }],
    ['a fractional price', { ...valid, priceHtPerM3Centimes: 1.5 }],
  ])('refuses %s', (_name, input) => {
    expect(parseOverrideInput(input)).toEqual({ ok: false, error: 'INVALID' });
  });
});

describe('the reference price per plant (C3)', () => {
  const versions = [
    price('all', null, '2026-01-01', 90_000),
    price('tetouan', null, '2026-02-01', 95_000, 'B25', 'P-TET'),
    price('tetouan2', null, '2026-06-01', 97_000, 'B25', 'P-TET'),
    price('cust', 'c1', '2026-03-01', 80_000),
  ];
  it('a plant price beats the all-plants price for its own plant only', () => {
    expect(resolveSellingPrice(versions, 'B25', null, '2026-03-01', 'P-TET')).toMatchObject({
      value: { id: 'tetouan' },
    });
    expect(resolveSellingPrice(versions, 'B25', null, '2026-07-01', 'P-TET')).toMatchObject({
      value: { id: 'tetouan2' },
    });
    expect(resolveSellingPrice(versions, 'B25', null, '2026-07-01', 'P-CHE')).toMatchObject({
      value: { id: 'all' },
    });
    expect(resolveSellingPrice(versions, 'B25', null, '2026-07-01')).toMatchObject({ value: { id: 'all' } });
  });
  it('before its own start a plant falls back to the all-plants price', () => {
    expect(resolveSellingPrice(versions, 'B25', null, '2026-01-15', 'P-TET')).toMatchObject({
      value: { id: 'all' },
    });
  });
  it('a client agreement beats both', () => {
    expect(resolveSellingPrice(versions, 'B25', 'c1', '2026-07-01', 'P-TET')).toMatchObject({
      value: { id: 'cust' },
    });
  });
  it('a plant is only accepted on a list price input', () => {
    expect(
      parseListPriceInput({
        concreteTypeId: crypto.randomUUID(),
        plantId: crypto.randomUUID(),
        priceHtPerM3Centimes: 1,
        effectiveFrom: '2026-06-01',
      }).ok,
    ).toBe(true);
  });
});
