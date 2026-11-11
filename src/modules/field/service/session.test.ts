import { describe, expect, it } from 'vitest';
import { hashDeviceId, signFieldToken, verifyFieldToken } from './session';

const secret = 'x'.repeat(40);
const token = {
  driverId: '0194a8a0-0000-7000-8000-000000000001',
  deviceHash: 'abc',
  deviceRowId: '0194a8a0-0000-7000-8000-0000000000aa',
  gen: 3,
  exp: 2_000_000_000,
};

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
  it('R18-04: a token without the device row id, or with one that is not a UUID, is refused', () => {
    const { deviceRowId: _omit, ...without } = token;
    void _omit;
    expect(verifyFieldToken(secret, signFieldToken(secret, without as never), 1)).toBeNull();
    expect(verifyFieldToken(secret, signFieldToken(secret, { ...token, deviceRowId: 'abc' }), 1)).toBeNull();
  });
  it('T10c: a token without a generation (issued before the server could end sessions) or with a fractional one is refused', () => {
    const old = { driverId: token.driverId, deviceHash: token.deviceHash, exp: token.exp };
    expect(verifyFieldToken(secret, signFieldToken(secret, old as never), 1)).toBeNull();
    expect(verifyFieldToken(secret, signFieldToken(secret, { ...token, gen: 1.5 }), 1)).toBeNull();
    expect(verifyFieldToken(secret, signFieldToken(secret, { ...token, gen: '3' } as never), 1)).toBeNull();
  });
  it('hashes a device id, the same way each time', () => {
    expect(hashDeviceId(secret, 'phone-1')).toBe(hashDeviceId(secret, 'phone-1'));
    expect(hashDeviceId(secret, 'phone-1')).not.toBe(hashDeviceId(secret, 'phone-2'));
    expect(hashDeviceId(secret, 'phone-1')).not.toContain('phone');
  });
});
