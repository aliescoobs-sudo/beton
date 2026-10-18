import { describe, expect, it } from 'vitest';
import { createTestClock, realClock } from './clock';

describe('realClock', () => {
  it('tracks real time', () => {
    const before = Date.now();
    const now = realClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now - before).toBeLessThan(1000);
  });

  it('gives today as a Casablanca business date', () => {
    expect(realClock.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('createTestClock', () => {
  it('starts at the given instant and only moves when told', () => {
    const clock = createTestClock(new Date('2026-11-23T06:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-11-23T06:00:00.000Z');
    clock.advanceBy({ minutes: 31 });
    expect(clock.now().toISOString()).toBe('2026-11-23T06:31:00.000Z');
    expect(clock.today()).toBe('2026-11-23');
  });

  it('returns a copy so callers cannot move time by mutating the Date', () => {
    const clock = createTestClock(new Date('2026-11-23T06:00:00Z'));
    clock.now().setUTCFullYear(2030);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('refuses to move backwards', () => {
    const clock = createTestClock(new Date('2026-11-23T06:00:00Z'));
    expect(() => clock.set(new Date('2026-11-22T06:00:00Z'))).toThrow(/backwards/);
  });
});
