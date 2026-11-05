import { afterAll, describe, expect, it } from 'vitest';
import { realClock } from '../src/modules/clock';
import { ipIsLocked, readParameters, recordLogin } from '../src/modules/platform-security';
import { authTestKit } from './auth-helpers';

// R11-01: the phone sign-in has a per-IP limit in front of the per-driver lock (same parameters as the office sign-in).
const kit = authTestKit();
afterAll(() => kit.close());
const guard = () => ({
  pool: kit.authPool,
  hmacKey: kit.env.LOOKUP_HMAC_KEY,
  clock: realClock,
  parameters: () => readParameters(kit.authPool),
});

describe('per-IP limit on the phone sign-in', () => {
  it('locks an IP after the configured number of failures, and only that IP', async () => {
    const g = guard();
    const limit = (await g.parameters())['auth.lockout_ip_failures'];
    const ip = '198.51.100.' + (Math.floor(Math.random() * 200) + 1);
    const other = '192.0.2.' + (Math.floor(Math.random() * 200) + 1);
    expect(await ipIsLocked(g, ip)).toBe(false);
    for (let i = 0; i < limit - 1; i++) await recordLogin(g, 'field-phone', ip, false);
    expect(await ipIsLocked(g, ip)).toBe(false);
    await recordLogin(g, 'field-phone', ip, false);
    expect(await ipIsLocked(g, ip)).toBe(true);
    expect(await ipIsLocked(g, other)).toBe(false);
  });
  it('an unknown IP is never limited (nobody is locked out by a missing header)', async () => {
    expect(await ipIsLocked(guard(), null)).toBe(false);
  });
});
