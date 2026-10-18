import { describe, expect, it } from 'vitest';
import { defaultParameters, PARAMETERS, parseParameter } from './parameters';

describe('parameter registry (T19)', () => {
  it('has the spec defaults', () => {
    expect(defaultParameters()).toMatchObject({
      'auth.lockout_account_failures': 5,
      'auth.lockout_ip_failures': 20,
      'auth.lockout_window_minutes': 15,
      'auth.session_absolute_hours': 12,
      'auth.step_up_minutes': 10,
      'clock.job.morning_recompute': '06:30',
      'clock.job.daily_brief': '07:00',
      'clock.job.due_reminders': '07:05',
      'clock.job.day_close': '20:00',
    });
  });

  it('accepts a valid value', () => {
    expect(parseParameter('auth.step_up_minutes', 5)).toEqual({ ok: true, value: 5 });
    expect(parseParameter('clock.job.day_close', '21:30')).toEqual({ ok: true, value: '21:30' });
  });

  it.each([
    ['auth.step_up_minutes', 30], // weaker than the spec: refused
    ['auth.step_up_minutes', 0],
    ['auth.lockout_account_failures', 50],
    ['auth.session_absolute_hours', 48],
    ['auth.lockout_window_minutes', 1.5],
    ['clock.job.day_close', '25:00'],
    ['clock.job.day_close', 2000],
  ])('rejects %s = %j', (key, value) => {
    expect(parseParameter(key as never, value).ok).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(parseParameter('nope' as never, 1).ok).toBe(false);
  });

  it('security parameters can only be made stricter than the spec defaults', () => {
    for (const [key, def] of Object.entries(PARAMETERS)) {
      if (!key.startsWith('auth.')) continue;
      const value = def.default as number;
      const weaker = key === 'auth.lockout_window_minutes' ? value - 1 : value + 1;
      expect(parseParameter(key as never, weaker).ok, key).toBe(false);
    }
  });
});
