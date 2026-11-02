import { describe, expect, it } from 'vitest';
import { hashDeviceId, signFieldToken, verifyFieldToken } from './session';

const secret = 'x'.repeat(40);
const token = { driverId: '0194a8a0-0000-7000-8000-000000000001', deviceHash: 'abc', exp: 2_000_000_000 };

describe('the phone session token (AC-PROD-25)', () => {
  it('round-trips and expires', () => {
    const t = signFieldToken(secret, token);
    expect(verifyFieldToken(secret, t, 1_900_000_000)).toEqual(token);
    expect(verifyFieldToken(secret, t, 2_000_000_001)).toBeNull();
  });
  it('refuses a forged, truncated, re-signed-with-another-key or empty token', () => {
    const t = signFieldToken(secret, token);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...token, driverId: '0194a8a0-0000-7000-8000-0000000000ff' }),
    ).toString('base64url');
    expect(verifyFieldToken(secret, `${forged}.${sig}`, 1)).toBeNull();
    expect(verifyFieldToken(secret, `${body}`, 1)).toBeNull();
    expect(verifyFieldToken('y'.repeat(40), t, 1)).toBeNull();
    expect(verifyFieldToken(secret, undefined, 1)).toBeNull();
    expect(verifyFieldToken(secret, 'a.b', 1)).toBeNull();
  });
  it('hashes a device id, the same way each time', () => {
    expect(hashDeviceId(secret, 'phone-1')).toBe(hashDeviceId(secret, 'phone-1'));
    expect(hashDeviceId(secret, 'phone-1')).not.toBe(hashDeviceId(secret, 'phone-2'));
    expect(hashDeviceId(secret, 'phone-1')).not.toContain('phone');
  });
});
