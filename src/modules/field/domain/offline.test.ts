import { describe, expect, it } from 'vitest';
import {
  judgeDay,
  mustWipeForAccount,
  OFFLINE_MAX_AGE_MS,
  readStoredDay,
  readStoredQueue,
  REVALIDATE_MS,
  rewrapDay,
  wrapDay,
} from './offline';

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

describe('the 18 hours are a hard limit (R11-06)', () => {
  const HOUR = 3_600_000;
  it('a local tap keeps the time the server last vouched for the day; it never extends it', () => {
    const read = NOW - 17 * HOUR;
    const raw = JSON.stringify(wrapDay('u1', { n: 1 }, read));
    // a tap one hour before the limit, then another right after the limit
    const afterTap = rewrapDay(raw, 'u1', { n: 2 }, NOW);
    expect(afterTap).not.toBeNull();
    expect(JSON.parse(afterTap!)).toMatchObject({ userId: 'u1', savedAt: read, day: { n: 2 } });
    const later = NOW + 2 * HOUR; // 19 hours after the server read
    expect(readStoredDay(afterTap, later)).toBeNull();
    expect(rewrapDay(afterTap, 'u1', { n: 3 }, later)).toBeNull();
  });
  it('a tap on an expired, foreign or damaged day writes nothing', () => {
    const old = JSON.stringify(wrapDay('u1', {}, NOW - OFFLINE_MAX_AGE_MS - 1));
    expect(rewrapDay(old, 'u1', {}, NOW)).toBeNull();
    expect(rewrapDay(JSON.stringify(wrapDay('u1', {}, NOW)), 'u2', {}, NOW)).toBeNull();
    expect(rewrapDay('{', 'u1', {}, NOW)).toBeNull();
    expect(rewrapDay(null, 'u1', {}, NOW)).toBeNull();
  });
  it('judges the day at any moment: fresh, stale (ask the server, revocation is looked for), none (erase or sign in)', () => {
    const at = (age: number) => JSON.stringify(wrapDay('u1', {}, NOW - age));
    expect(judgeDay(at(60_000), NOW)).toBe('fresh');
    expect(judgeDay(at(REVALIDATE_MS + 1), NOW)).toBe('stale');
    expect(judgeDay(at(OFFLINE_MAX_AGE_MS - 1), NOW)).toBe('stale');
    expect(judgeDay(at(OFFLINE_MAX_AGE_MS + 1), NOW)).toBe('none');
    expect(judgeDay(null, NOW)).toBe('none');
    expect(judgeDay('{', NOW)).toBe('none');
  });
  it('a page left open crosses the limit: the same stored day is stale, then none, as the clock moves', () => {
    const raw = JSON.stringify(wrapDay('u1', {}, NOW));
    expect(judgeDay(raw, NOW + HOUR)).toBe('stale');
    expect(judgeDay(raw, NOW + 17 * HOUR)).toBe('stale');
    expect(judgeDay(raw, NOW + 19 * HOUR)).toBe('none');
  });
});
