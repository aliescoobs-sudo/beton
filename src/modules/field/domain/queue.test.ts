import { describe, expect, it } from 'vitest';
import { applyOutcomes, enqueue, newKey, parseQueue, type QueueAction } from './queue';

const tap = (key: string, step = 'departed'): QueueAction => ({
  kind: 'step',
  key,
  tripId: 't',
  step,
  at: '2026-11-10T08:00:00Z',
});

describe('the offline queue (AC-PROD-24)', () => {
  it('keys are random and 24 hex characters', () => {
    expect(newKey()).toMatch(/^[0-9a-f]{24}$/);
    expect(newKey()).not.toBe(newKey());
  });
  it('a tap queued twice with the same key is kept once, in order', () => {
    const q = enqueue(enqueue([], tap('a')), tap('b', 'arrived'));
    expect(enqueue(q, tap('a')).map((x) => x.key)).toEqual(['a', 'b']);
  });
  it('stored taps and replays leave the queue; a retryable refusal stays in place; a final refusal leaves', () => {
    const q = [tap('a'), tap('b', 'arrived'), tap('c', 'unloading_started'), tap('d', 'back')];
    const next = applyOutcomes(q, [
      { key: 'a', status: 'recorded' },
      { key: 'b', status: 'replayed' },
      { key: 'c', status: 'rejected', code: 'wait_load', retry: true },
      { key: 'd', status: 'rejected', code: 'invalid', retry: false },
    ]);
    expect(next.map((x) => x.key)).toEqual(['c']);
  });
  it('an unanswered tap stays queued; a broken store reads as empty', () => {
    expect(applyOutcomes([tap('a')], []).map((x) => x.key)).toEqual(['a']);
    expect(parseQueue('not json')).toEqual([]);
    expect(parseQueue(JSON.stringify([tap('a'), 5, null]))).toHaveLength(1);
    expect(parseQueue(null)).toEqual([]);
  });
});
