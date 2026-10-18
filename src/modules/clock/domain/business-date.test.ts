import { describe, expect, it } from 'vitest';
import { businessDateOf } from './business-date';

// Offsets follow the IANA tz data shipped with Node (2026c): Casablanca is UTC+1 in
// July 2026 and UTC+0 in November 2026. If Morocco changes its rules, update tz data, not code.
describe('businessDateOf (Africa/Casablanca)', () => {
  it('is still the same day at 22:59 UTC when Casablanca is UTC+1', () => {
    expect(businessDateOf(new Date('2026-07-01T22:59:00Z'))).toBe('2026-07-01');
  });

  it('turns to the next day at 23:00 UTC when Casablanca is UTC+1', () => {
    expect(businessDateOf(new Date('2026-07-01T23:00:00Z'))).toBe('2026-07-02');
  });

  it('turns to the next day at midnight UTC when Casablanca is UTC+0', () => {
    expect(businessDateOf(new Date('2026-11-23T23:59:00Z'))).toBe('2026-11-23');
    expect(businessDateOf(new Date('2026-11-24T00:00:00Z'))).toBe('2026-11-24');
  });
});
