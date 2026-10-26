import { describe, expect, it } from 'vitest';
import { stageState, waitingFor } from './order-chain';

describe('stageState (AC-INT-16)', () => {
  it('none, partial and complete against what was ordered', () => {
    expect(stageState(0, 10_000)).toBe('none');
    expect(stageState(-500, 10_000)).toBe('none');
    expect(stageState(4_000, 10_000)).toBe('partial');
    expect(stageState(10_000, 10_000)).toBe('complete');
    expect(stageState(12_000, 10_000)).toBe('complete');
  });
});

describe('waitingFor', () => {
  const states = (
    planned: 'none' | 'partial' | 'complete',
    loaded = planned,
    delivered = loaded,
    invoiced = delivered,
  ) => ({
    ordered: 'complete' as const,
    planned,
    loaded,
    delivered,
    invoiced,
  });
  it('is the first stage not complete', () => {
    expect(waitingFor(states('none'), null)).toBe('planned');
    expect(waitingFor(states('complete', 'partial'), null)).toBe('loaded');
    expect(waitingFor(states('complete', 'complete', 'complete', 'none'), null)).toBe('invoiced');
  });
  it('waits for the payment only for a role that can see it', () => {
    expect(waitingFor(states('complete'), 'unpaid')).toBe('paid');
    expect(waitingFor(states('complete'), 'paid')).toBeNull();
    expect(waitingFor(states('complete'), null)).toBeNull();
  });
});
