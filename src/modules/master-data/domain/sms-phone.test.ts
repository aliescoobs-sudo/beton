import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhoneE164, phoneLookupHash } from './sms-phone';

describe('normalizePhoneE164', () => {
  it.each([
    ['0612345678', '+212612345678'],
    ['06 12 34 56 78', '+212612345678'],
    ['+212 6-12-34-56-78', '+212612345678'],
    ['00212612345678', '+212612345678'],
    ['٠٦١٢٣٤٥٦٧٨', '+212612345678'],
    ['０７１２３４５６７８', '+212712345678'],
    ['+33 6 12 34 56 78', '+33612345678'],
  ])('%s -> %s', (input, expected) => expect(normalizePhoneE164(input)).toBe(expected));
  it.each(['', 'abc', '12345', '0912345678', '+0123456789', '06123456789012', '++212612345678'])(
    'rejects %j',
    (input) => expect(normalizePhoneE164(input)).toBeNull(),
  );
});

describe('phoneLookupHash', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  it('is a stable 64-hex keyed hash, different per key and per number, and never contains the number', () => {
    const h = phoneLookupHash(key, '+212612345678');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneLookupHash(key, '+212612345678')).toBe(h);
    expect(phoneLookupHash(Buffer.alloc(32, 8).toString('base64'), '+212612345678')).not.toBe(h);
    expect(phoneLookupHash(key, '+212612345679')).not.toBe(h);
    expect(h).not.toContain('612345678');
  });
  it('masks to the last three digits', () => expect(maskPhone('+212612345678')).toBe('•••678'));
});
