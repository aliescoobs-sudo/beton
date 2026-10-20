import { describe, expect, it } from 'vitest';
import { dailyCron, JOB_CATALOGUE } from './job-catalogue';

describe('job catalogue', () => {
  it('lists the four daily jobs in chronological order', () => {
    expect(JOB_CATALOGUE.map((j) => j.key)).toEqual([
      'morning-recompute',
      'daily-brief',
      'due-reminders',
      'day-close',
    ]);
    const times = JOB_CATALOGUE.map((j) => j.defaultTime);
    expect([...times].sort()).toEqual(times);
  });

  it('turns HH:MM into a daily cron expression', () => {
    expect(dailyCron('06:30')).toBe('30 6 * * *');
    expect(dailyCron('20:00')).toBe('0 20 * * *');
  });

  it.each(['25:00', '6:30', '', '20:60'])('rejects %j', (bad) => {
    expect(() => dailyCron(bad)).toThrow();
  });
});
