import { describe, expect, it } from 'vitest';
import { parsePin } from './pin';

describe('driver PIN policy (AC-PROD-25)', () => {
  it('accepts 4 to 6 digits', () => {
    expect(parsePin('4829')).toEqual({ ok: true, value: '4829' });
    expect(parsePin('482913')).toMatchObject({ ok: true });
  });
  it('refuses anything else, repeats and runs', () => {
    for (const bad of ['123', '1234567', 'abcd', '12 34', 12345, null])
      expect(parsePin(bad)).toEqual({ ok: false, error: 'INVALID' });
    for (const easy of ['0000', '1111', '1234', '4321', '123456', '654321'])
      expect(parsePin(easy), easy).toEqual({ ok: false, error: 'TOO_EASY' });
  });
});
