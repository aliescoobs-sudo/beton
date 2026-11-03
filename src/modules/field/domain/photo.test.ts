import { describe, expect, it } from 'vitest';
import { fitWithin, photoVerdict } from './photo';

describe('queued BL photo (C3)', () => {
  it('is sent on 200, kept on a signed-out or server problem, dropped on a refusal that cannot change', () => {
    expect(photoVerdict(200)).toBe('sent');
    for (const s of [401, 408, 429, 500, 502, 503]) expect(photoVerdict(s), String(s)).toBe('retry');
    expect(photoVerdict(null)).toBe('retry');
    for (const s of [400, 403, 413, 422]) expect(photoVerdict(s), String(s)).toBe('drop');
  });
  it('waits for the unloading tap when the server has not seen it yet', () => {
    expect(photoVerdict(422, 'NOT_UNLOADED')).toBe('retry');
    expect(photoVerdict(422, 'TOO_MANY')).toBe('drop');
  });
  it('shrinks a large photo to 1600 px on its longest side and never enlarges', () => {
    expect(fitWithin(4000, 3000)).toEqual({ w: 1600, h: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ w: 1200, h: 1600 });
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
  });
});
