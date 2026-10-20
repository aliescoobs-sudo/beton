import { describe, expect, it } from 'vitest';
import { parseClientInput } from './client';
import { normalizeIce, normalizeName } from './party';

describe('normalizeIce', () => {
  it('keeps 15 digits and drops separators', () => {
    expect(normalizeIce('001 234-567.890123')).toBe('001234567890123');
  });
  it.each(['', '12345', '00123456789012a', '0012345678901234'])('rejects %j', (raw) => {
    expect(normalizeIce(raw)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(normalizeName('  Société  ATLAS S.A. ')).toBe(normalizeName('societe atlas s a'));
  });
  it('keeps Arabic letters apart from each other', () => {
    expect(normalizeName('شركة الأطلس')).not.toBe(normalizeName('شركة الريف'));
    expect(normalizeName('شركة  الأطلس')).toBe(normalizeName('شركة الأطلس'));
  });
});

describe('parseClientInput (AC-MD-01)', () => {
  it('needs only a name and a kind; payment terms default to 60 days', () => {
    expect(parseClientInput({ name: ' Chantier  Martil ', kind: 'person' })).toMatchObject({
      ok: true,
      value: { name: 'Chantier Martil', kind: 'person', paymentTermsDays: 60 },
    });
  });
  it('treats blank optional fields as absent', () => {
    expect(
      parseClientInput({ name: 'A', kind: 'company', ice: '', phone: '', defaultZoneId: '', notes: ' ' }),
    ).toMatchObject({ ok: true, value: { ice: undefined, phone: undefined, defaultZoneId: undefined } });
  });
  it('stores the ICE normalized and refuses a malformed one', () => {
    expect(parseClientInput({ name: 'A', kind: 'company', ice: '0012 3456 7890 123' })).toMatchObject({
      ok: true,
      value: { ice: '001234567890123' },
    });
    expect(parseClientInput({ name: 'A', kind: 'company', ice: '123' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });
  it('refuses an ICE on a person, a kind outside the list and payment terms over 120 days', () => {
    expect(parseClientInput({ name: 'A', kind: 'person', ice: '001234567890123' }).ok).toBe(false);
    expect(parseClientInput({ name: 'A', kind: 'other' }).ok).toBe(false);
    expect(parseClientInput({ name: 'A', kind: 'person', paymentTermsDays: 121 }).ok).toBe(false);
    expect(parseClientInput({ name: '', kind: 'person' }).ok).toBe(false);
  });
});
