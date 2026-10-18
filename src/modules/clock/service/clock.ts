import { type BusinessDate, businessDateOf } from '../domain/business-date';

/** The only source of "now" in the system. Business code receives a Clock; it never reads time itself. */
export interface Clock {
  now(): Date;
  today(): BusinessDate;
}

export const realClock: Clock = {
  now: () => new Date(),
  today: () => businessDateOf(new Date()),
};

export interface TestClock extends Clock {
  set(instant: Date): void;
  advanceBy(step: { days?: number; hours?: number; minutes?: number; seconds?: number }): void;
}

/** Deterministic clock for tests: starts at `start`, moves only forward and only when told. */
export function createTestClock(start: Date): TestClock {
  let current = start.getTime();

  const set = (instant: Date) => {
    if (instant.getTime() < current) throw new Error('Test clock cannot move backwards');
    current = instant.getTime();
  };

  return {
    now: () => new Date(current),
    today: () => businessDateOf(new Date(current)),
    set,
    advanceBy: ({ days = 0, hours = 0, minutes = 0, seconds = 0 }) =>
      set(new Date(current + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000)),
  };
}
