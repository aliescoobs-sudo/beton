import { describe, expect, it } from 'vitest';
import { mustWipeForAccount, OFFLINE_MAX_AGE_MS, readStoredDay, readStoredQueue, wrapDay } from './offline';

const NOW = Date.parse('2026-06-02T09:00:00Z');

describe('the day kept for the road (F02)', () => {
  it('is shown to the account that read it, while it is young', () => {
    const raw = JSON.stringify(wrapDay('u1', { trips: [] }, NOW - 3_600_000));
    expect(readStoredDay(raw, NOW)).toMatchObject({ userId: 'u1', day: { trips: [] } });
  });
  it('is not shown once it is older than the offline age', () => {
    const raw = JSON.stringify(wrapDay('u1', { trips: [] }, NOW - OFFLINE_MAX_AGE_MS - 1));
    expect(readStoredDay(raw, NOW)).toBeNull();
    expect(readStoredDay(JSON.stringify(wrapDay('u1', {}, NOW - OFFLINE_MAX_AGE_MS)), NOW)).not.toBeNull();
  });
  it('is not shown when it has no owner (the old format), is malformed, or comes from the future', () => {
    expect(readStoredDay(JSON.stringify({ kind: 'driver', trips: [] }), NOW)).toBeNull();
    expect(readStoredDay('{', NOW)).toBeNull();
    expect(readStoredDay(null, NOW)).toBeNull();
    expect(readStoredDay(JSON.stringify(wrapDay('u1', {}, NOW + 3_600_000)), NOW)).toBeNull();
    expect(readStoredDay(JSON.stringify({ userId: '', savedAt: NOW, day: {} }), NOW)).toBeNull();
  });
});

describe('the queue of taps belongs to one account (F02)', () => {
  it('reads the owner and the actions; a bare list has no owner and is refused', () => {
    expect(readStoredQueue(JSON.stringify({ userId: 'u1', actions: [{ key: 'a' }, { nokey: 1 }] }))).toEqual({
      userId: 'u1',
      actions: [{ key: 'a' }],
    });
    expect(readStoredQueue(JSON.stringify([{ key: 'a' }]))).toBeNull();
    expect(readStoredQueue(null)).toBeNull();
  });
});

describe('account switch (F02)', () => {
  it('wipes when anything held belongs to another account, never for the same one or for nothing', () => {
    expect(mustWipeForAccount('u2', ['u1', null])).toBe(true);
    expect(mustWipeForAccount('u2', [null, undefined, 'u2'])).toBe(false);
    expect(mustWipeForAccount('u2', [])).toBe(false);
    expect(mustWipeForAccount('u2', ['u2', 'u1'])).toBe(true);
  });
});
