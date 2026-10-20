import { describe, expect, it } from 'vitest';
import { clientIp } from './login-guard';

const xff = (value: string) => new Headers({ 'x-forwarded-for': value });

describe('clientIp (per-IP lockout)', () => {
  it('ignores X-Forwarded-For without a trusted proxy', () => {
    expect(clientIp(xff('203.0.113.9'), 0)).toBeNull();
  });

  it('takes the entry the one trusted proxy appended, not what the client claimed', () => {
    expect(clientIp(xff('198.51.100.1, 203.0.113.9'), 1)).toBe('203.0.113.9');
    expect(clientIp(xff('1.2.3.4, 5.6.7.8, 203.0.113.9'), 1)).toBe('203.0.113.9');
  });

  it('counts back over each trusted proxy', () => {
    expect(clientIp(xff('1.2.3.4, 203.0.113.9, 10.0.0.2'), 2)).toBe('203.0.113.9');
  });

  it('is null when the header is shorter than the proxy chain, missing or not an address', () => {
    expect(clientIp(xff('203.0.113.9'), 2)).toBeNull();
    expect(clientIp(new Headers(), 1)).toBeNull();
    expect(clientIp(undefined, 1)).toBeNull();
    expect(clientIp(xff('not-an-ip'), 1)).toBeNull();
  });

  it('accepts IPv6', () => {
    expect(clientIp(xff('2001:db8::1'), 1)).toBe('2001:db8::1');
  });
});
