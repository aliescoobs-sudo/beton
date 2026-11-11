import { describe, expect, it } from 'vitest';
import { heldBanner } from './held-banner';

describe('R18-08: the held banner tells "unavailable" from zero', () => {
  it('a failed or missing answer is unavailable, never none', () => {
    expect(heldBanner(null)).toEqual({ kind: 'unavailable' });
    expect(heldBanner(undefined)).toEqual({ kind: 'unavailable' });
    expect(heldBanner({ ok: false })).toEqual({ kind: 'unavailable' });
    expect(heldBanner({ ok: true })).toEqual({ kind: 'unavailable' });
    expect(heldBanner({ ok: true, value: -1 })).toEqual({ kind: 'unavailable' });
    expect(heldBanner({ ok: true, value: 1.5 })).toEqual({ kind: 'unavailable' });
    expect(heldBanner({ ok: true, value: Number.NaN })).toEqual({ kind: 'unavailable' });
  });
  it('zero is none and a positive count is held', () => {
    expect(heldBanner({ ok: true, value: 0 })).toEqual({ kind: 'none' });
    expect(heldBanner({ ok: true, value: 3 })).toEqual({ kind: 'held', count: 3 });
  });
});
