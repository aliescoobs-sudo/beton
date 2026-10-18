import { describe, expect, it } from 'vitest';
import { createTestClock } from './clock';
import { createClockLogger } from './logger';

describe('createClockLogger', () => {
  it('stamps every line with the time of the given clock', () => {
    const lines: string[] = [];
    const clock = createTestClock(new Date('2026-11-25T07:00:00Z'));
    const log = createClockLogger({ clock, write: (line) => lines.push(line) });

    log.info('first');
    clock.advanceBy({ minutes: 5 });
    log.warn('second');

    expect(lines.map((line) => JSON.parse(line).ts)).toEqual([
      '2026-11-25T07:00:00.000Z',
      '2026-11-25T07:05:00.000Z',
    ]);
  });

  it('still scrubs secret values', () => {
    const lines: string[] = [];
    const log = createClockLogger({
      clock: createTestClock(new Date('2026-11-25T07:00:00Z')),
      secretValues: ['secret-value-abc'],
      write: (line) => lines.push(line),
    });
    log.error('failed with secret-value-abc');
    expect(lines[0]).not.toContain('secret-value-abc');
  });
});
