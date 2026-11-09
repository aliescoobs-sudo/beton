import { describe, expect, it } from 'vitest';
import { clockOf, minuteOfDay, nextStep, TRIP_STEPS, tripTimes } from './trip-times';

// Casablanca is UTC+1 outside Ramadan; July is safely outside it for every tz database.
const at = (hhmm: string) => `2026-07-06T${hhmm}:00.000Z`;

describe('nextStep', () => {
  it('is the first step not recorded, then null', () => {
    expect(nextStep({})).toBe('loading_started');
    expect(nextStep({ loading_started: at('06:50') })).toBe('loaded');
    expect(nextStep({ loading_started: at('06:50'), loaded: at('07:00') })).toBe('departed');
    expect(nextStep(Object.fromEntries(TRIP_STEPS.map((s) => [s, at('08:00')])))).toBeNull();
  });
  it('a skipped step is still the next one: the order is never jumped', () => {
    expect(nextStep({ loading_started: at('06:50'), loaded: at('07:00'), arrived: at('07:40') })).toBe(
      'departed',
    );
  });
});

describe('tripTimes (AC-OPS-17)', () => {
  const all = {
    loaded: at('07:00'),
    departed: at('07:10'),
    arrived: at('08:10'),
    unloading_started: at('08:40'),
    unloading_finished: at('09:05'),
    back: at('10:00'),
  };
  it('arrived 08:10, unloading started 08:40 → waited 30 min; the rest follows', () => {
    expect(tripTimes(all, null)).toEqual({
      waitingOnSiteMin: 30,
      unloadingMin: 25,
      roundTripMin: 170,
      concreteAgeMin: 125,
      departDelayMin: null,
    });
  });
  it('a skipped step leaves its figures empty, never zero', () => {
    const t = tripTimes({ loaded: at('07:00'), departed: at('07:10'), unloading_started: at('08:40') }, null);
    expect(t.waitingOnSiteMin).toBeNull();
    expect(t.unloadingMin).toBeNull();
    expect(t.roundTripMin).toBeNull();
    expect(t.concreteAgeMin).toBeNull();
  });
  it('the delay of the departure is against the plan, in Casablanca minutes', () => {
    // 07:10 UTC is 08:10 in Casablanca; planned 08:00 (480) → 10 minutes late
    expect(minuteOfDay(at('07:10'))).toBe(490);
    expect(clockOf(at('07:10'))).toBe('08:10');
    expect(tripTimes({ departed: at('07:10') }, { departMin: 480 }).departDelayMin).toBe(10);
    expect(tripTimes({ departed: at('07:10') }, { departMin: 500 }).departDelayMin).toBe(-10);
  });
});
