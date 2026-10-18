import { describe, expect, it } from 'vitest';
import { checkPassword } from './password-policy';

describe('checkPassword (SPEC-platform-security §5)', () => {
  it('accepts a long passphrase', () => {
    expect(checkPassword('correct-horse-battery-staple')).toEqual({ ok: true });
  });

  it('rejects fewer than 12 characters', () => {
    expect(checkPassword('short-pass1')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rejects more than 128 characters', () => {
    expect(checkPassword('a'.repeat(129))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('rejects a password from the common list, whatever the case', () => {
    expect(checkPassword('UnBelievable')).toEqual({ ok: false, reason: 'too_common' });
    expect(checkPassword('unbelievable!')).toEqual({ ok: true });
  });

  it('imposes no composition rules', () => {
    expect(checkPassword('onlylowercaseletters')).toEqual({ ok: true });
  });
});
