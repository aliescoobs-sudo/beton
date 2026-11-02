import { describe, expect, it } from 'vitest';
import { emergencyStage, EMERGENCY_OPTIONS, nextDriverTap, nextPumpStep } from './steps';

describe('the driver chain (AC-PROD-21)', () => {
  const at = '2026-11-10T08:00:00Z';
  it('runs the six taps in order, one at a time', () => {
    expect(nextDriverTap({ loadingStartedAt: null, steps: {} })).toEqual({ step: 'loading_started' });
    expect(nextDriverTap({ loadingStartedAt: at, steps: {} })).toEqual({ wait: 'wait_load' });
    expect(nextDriverTap({ loadingStartedAt: at, steps: { loaded: at } })).toEqual({ step: 'departed' });
    expect(nextDriverTap({ loadingStartedAt: at, steps: { loaded: at, departed: at } })).toEqual({
      step: 'arrived',
    });
    expect(nextDriverTap({ loadingStartedAt: at, steps: { loaded: at, departed: at, arrived: at } })).toEqual(
      {
        step: 'unloading_started',
      },
    );
    expect(
      nextDriverTap({
        loadingStartedAt: at,
        steps: { loaded: at, departed: at, arrived: at, unloading_started: at },
      }),
    ).toEqual({ step: 'unloading_finished' });
    expect(
      nextDriverTap({
        loadingStartedAt: at,
        steps: { loaded: at, departed: at, arrived: at, unloading_started: at, unloading_finished: at },
      }),
    ).toEqual({ step: 'back' });
    expect(
      nextDriverTap({
        loadingStartedAt: at,
        steps: {
          loaded: at,
          departed: at,
          arrived: at,
          unloading_started: at,
          unloading_finished: at,
          back: at,
        },
      }),
    ).toBeNull();
  });
  it('the loading tap is offered until the truck has left, even if the plant has already recorded the load', () => {
    expect(nextDriverTap({ loadingStartedAt: null, steps: { loaded: at } })).toEqual({
      step: 'loading_started',
    });
  });
  it('a rotation already on the road never asks for the loading again', () => {
    expect(nextDriverTap({ loadingStartedAt: null, steps: { loaded: at, departed: at } })).toEqual({
      step: 'arrived',
    });
  });
});

describe('the emergency options depend on the step (AC-PROD-22)', () => {
  it('unloading offers "load not enough", the road offers a breakdown and an accident', () => {
    expect(EMERGENCY_OPTIONS.unloading_started).toContain('load_not_enough');
    expect(EMERGENCY_OPTIONS.unloading_started).toContain('quality_refused');
    expect(EMERGENCY_OPTIONS.departed).toEqual(
      expect.arrayContaining(['breakdown', 'accident', 'heavy_delay', 'client_cancelled', 'site_closed']),
    );
    expect(EMERGENCY_OPTIONS.departed).not.toContain('load_not_enough');
  });
  it('the stage is the latest tracking step', () => {
    expect(emergencyStage({})).toBe('start');
    expect(emergencyStage({ loaded: 'x', departed: 'y' })).toBe('departed');
  });
});

describe('the pump chain (AC-PROD-26)', () => {
  it('has the five steps in order', () => {
    expect(nextPumpStep([])).toBe('arrived');
    expect(nextPumpStep(['arrived', 'set_up'])).toBe('pumping_started');
    expect(nextPumpStep(['arrived', 'set_up', 'pumping_started', 'pumping_ended', 'left'])).toBeNull();
  });
});
