import { describe, expect, it } from 'vitest';
import { formatRib, legalMentions, parseCompanyProfileInput } from './company';

const base = {
  legalName: '  KAYAS  Pilote  ',
  legalForm: 'SARL',
  ice: '001 234 567 000 089',
  ifNumber: '12345678',
  rcNumber: 'TET-4567',
  patente: '9876543',
  address: 'Zone industrielle, Tétouan',
};

describe('parseCompanyProfileInput', () => {
  it('cleans spaces, accepts an ICE typed in groups and a RIB, optional fields default to null', () => {
    const r = parseCompanyProfileInput({ ...base, rib: '181 780 0000123456789012 34' });
    expect(r.ok && r.value).toMatchObject({
      legalName: 'KAYAS Pilote',
      ice: '001234567000089',
      rib: '181780000012345678901234',
      phone: null,
      email: null,
    });
  });
  it('refuses an ICE or a RIB of the wrong length and a missing name', () => {
    expect(parseCompanyProfileInput({ ...base, ice: '123' }).ok).toBe(false);
    expect(parseCompanyProfileInput({ ...base, rib: '123' }).ok).toBe(false);
    expect(parseCompanyProfileInput({ ...base, legalName: ' ' }).ok).toBe(false);
    expect(parseCompanyProfileInput({ ...base, rib: '' }).ok).toBe(true);
  });
});

describe('legalMentions', () => {
  it('prints the identity, the registrations and the RIB when there is one', () => {
    const lines = legalMentions({
      effectiveFrom: '2026-01-01',
      legalName: 'KAYAS',
      legalForm: 'SARL',
      ice: '001234567000089',
      ifNumber: '1',
      rcNumber: '2',
      patente: '3',
      address: 'Tétouan',
      phone: null,
      email: null,
      rib: '181780000012345678901234',
    });
    expect(lines).toEqual([
      'KAYAS (SARL)',
      'Tétouan',
      'ICE 001234567000089 · IF 1 · RC 2 · Patente 3',
      'RIB 181 780 0000123456789012 34',
    ]);
    expect(formatRib('123')).toBe('123');
  });
});
