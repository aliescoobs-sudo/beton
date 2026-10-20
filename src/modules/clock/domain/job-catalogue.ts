/** Daily job catalogue (SPEC-clock §3). Times are Africa/Casablanca business time and configurable (T19). */
export const JOB_CATALOGUE = [
  { key: 'morning-recompute', parameterKey: 'clock.job.morning_recompute', defaultTime: '06:30' },
  { key: 'daily-brief', parameterKey: 'clock.job.daily_brief', defaultTime: '07:00' },
  { key: 'due-reminders', parameterKey: 'clock.job.due_reminders', defaultTime: '07:05' },
  { key: 'day-close', parameterKey: 'clock.job.day_close', defaultTime: '20:00' },
] as const;

export type JobKey = (typeof JOB_CATALOGUE)[number]['key'];

/** `HH:MM` → a daily cron expression (`MM HH * * *`). */
export function dailyCron(time: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`Invalid job time "${time}" (expected HH:MM)`);
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}
