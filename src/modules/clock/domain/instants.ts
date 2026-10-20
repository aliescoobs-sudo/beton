import { type BusinessDate, BUSINESS_TIME_ZONE, businessDateOf } from './business-date';

export interface ScheduledJobTime {
  jobKey: string;
  /** `HH:MM`, Africa/Casablanca. */
  time: string;
}

export interface JobInstant {
  at: Date;
  jobKey: string;
  businessDate: BusinessDate;
}

const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localDateTime(instant: Date): { date: string; time: string } {
  const parts = Object.fromEntries(localFormatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Casablanca is UTC+1, or UTC+0 during Ramadan; the offset in minutes that makes `date time` a real local time. */
const CASABLANCA_OFFSETS_MIN = [60, 0];

/** The instant at which the Casablanca wall clock reads `time` on `date`. */
export function casablancaInstant(date: BusinessDate, time: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  for (const offset of CASABLANCA_OFFSETS_MIN) {
    const candidate = new Date(wall - offset * 60_000);
    const local = localDateTime(candidate);
    if (local.date === date && local.time === time) return candidate;
  }
  return new Date(wall - 60 * 60_000);
}

function nextDate(date: BusinessDate): BusinessDate {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10) as BusinessDate;
}

/**
 * Every daily job instant in (`from`, `to`], in chronological order; at the same instant, in `jobs` order. Each
 * instant carries the business date it belongs to, so a job crossed on day D runs for D.
 */
export function jobInstantsBetween(from: Date, to: Date, jobs: readonly ScheduledJobTime[]): JobInstant[] {
  const instants: JobInstant[] = [];
  const last = businessDateOf(to);
  for (let date = businessDateOf(from); date <= last; date = nextDate(date)) {
    for (const { jobKey, time } of jobs) {
      const at = casablancaInstant(date, time);
      if (at > from && at <= to) instants.push({ at, jobKey, businessDate: date });
    }
  }
  return instants.sort((a, b) => a.at.getTime() - b.at.getTime());
}
