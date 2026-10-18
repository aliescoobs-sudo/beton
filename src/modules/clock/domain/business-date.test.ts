import { describe, expect, it } from 'vitest';
import { businessDateOf } from './business-date';

// Offsets follow the IANA tz data shipped with Node (2026c): Casablanca was UTC+1 until
// 19 Sept 2026 and is on UTC+0 permanently since 20 Sept 2026 (decree 2.26.530, no Ramadan switch).
// If Morocco changes its rules again, update tz data, not code.
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

  it('stays on UTC+0 the following summer and during Ramadan (no switch since 20 Sept 2026)', () => {
    expect(businessDateOf(new Date('2027-07-01T23:30:00Z'))).toBe('2027-07-01');
    expect(businessDateOf(new Date('2027-02-20T23:30:00Z'))).toBe('2027-02-20');
  });
});
