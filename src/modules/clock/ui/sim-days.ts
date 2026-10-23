export type SimDayState = 'past' | 'today' | 'future';
export interface SimDay {
  date: string;
  /** Day of the month, what the strip shows. */
  day: number;
  state: SimDayState;
}

const DAY_MS = 86_400_000;

/**
 * The days around the simulated date for the simulation strip: `before` days filled, today solid, `after` days dashed.
 * Calendar arithmetic on the business date string (UTC midnights, so no time zone or DST can shift a day).
 */
export function simDays(today: string, before = 7, after = 7): SimDay[] {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  const days: SimDay[] = [];
  for (let offset = -before; offset <= after; offset++) {
    const date = new Date(base + offset * DAY_MS);
    days.push({
      date: date.toISOString().slice(0, 10),
      day: date.getUTCDate(),
      state: offset < 0 ? 'past' : offset === 0 ? 'today' : 'future',
    });
  }
  return days;
}
