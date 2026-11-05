import { describe, expect, it } from 'vitest';
import { parseLoginPin, parsePin } from './pin';

describe('driver PIN policy (AC-PROD-25, F11)', () => {
  it('a new PIN has 6 to 8 digits', () => {
    expect(parsePin('482913')).toEqual({ ok: true, value: '482913' });
    expect(parsePin('48291357')).toMatchObject({ ok: true });
  });
  it('refuses anything else, repeats and runs', () => {
    for (const bad of ['123', '1234', '48291', '482913579', 'abcdef', '12 34 56', 123456, null])
      expect(parsePin(bad)).toEqual({ ok: false, error: 'INVALID' });
    for (const easy of ['000000', '111111', '123456', '654321', '12345678'])
      expect(parsePin(easy), easy).toEqual({ ok: false, error: 'TOO_EASY' });
  });
  it('sign-in still recognises the shape of an older 4 to 6 digit PIN, but not junk', () => {
    for (const ok of ['4829', '48291', '482913', '48291357'])
      expect(parseLoginPin(ok)).toEqual({ ok: true, value: ok });
    for (const bad of ['123', '482913579', 'abcd', '48 29', 4829, null, undefined])
      expect(parseLoginPin(bad)).toEqual({ ok: false, error: 'INVALID' });
  });
});
