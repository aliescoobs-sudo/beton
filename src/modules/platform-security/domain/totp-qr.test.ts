import { describe, expect, it } from 'vitest';
import { totpQrDataUrl } from './totp-qr';

const email = 'owner@kayas.test';
const uri = `otpauth://totp/KAYAS:${encodeURIComponent(email)}?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=KAYAS&algorithm=SHA1&digits=6&period=30`;

describe('totpQrDataUrl', () => {
  it('renders the enrolment URI as an SVG data URL', () => {
    const url = totpQrDataUrl(uri, email);
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(url!.split(',')[1]!, 'base64').toString('utf8');
    expect(svg).toMatch(/^<svg /);
    expect(svg).not.toContain('<script');
  });

  it('is deterministic (no randomness, no network)', () => {
    expect(totpQrDataUrl(uri, email)).toBe(totpQrDataUrl(uri, email));
  });

  it.each([
    ['not an otpauth URI', 'https://example.com/?secret=ABC'],
    ['HOTP instead of TOTP', uri.replace('otpauth://totp/', 'otpauth://hotp/')],
    ['another issuer', uri.replace(/issuer=KAYAS/, 'issuer=EVIL')],
    ['another account', uri.replace(encodeURIComponent(email), encodeURIComponent('other@kayas.test'))],
    ['no secret', uri.replace(/secret=[A-Z2-7]+&/, '')],
    ['a secret that is not base32', uri.replace(/secret=[A-Z2-7]+/, 'secret=not-base32!')],
  ])('refuses %s (the action is not a general QR generator)', (_case, input) => {
    expect(totpQrDataUrl(input, email)).toBeNull();
  });
});
