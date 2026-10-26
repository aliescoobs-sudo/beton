import { describe, expect, it } from 'vitest';
import { parseKeyring } from './keyring';

const k = (byte: number) => Buffer.alloc(32, byte).toString('base64');

describe('keyring (AC-SEC-10)', () => {
  it('encrypts with the current (first) key and tags the ciphertext with its id', () => {
    const ring = parseKeyring(`k2:${k(2)},k1:${k(1)}`);
    const sealed = ring.encrypt('+212 600-000-017');
    expect(sealed.startsWith('f1.k2.')).toBe(true);
    expect(sealed).not.toContain('600-000');
    expect(ring.decrypt(sealed)).toBe('+212 600-000-017');
  });

  it('decrypts values sealed with a previous key', () => {
    const old = parseKeyring(`k1:${k(1)}`).encrypt('secret');
    expect(parseKeyring(`k2:${k(2)},k1:${k(1)}`).decrypt(old)).toBe('secret');
  });

  it('reports which key sealed a value, so rotation can find old rows', () => {
    const ring = parseKeyring(`k2:${k(2)},k1:${k(1)}`);
    expect(ring.keyIdOf(parseKeyring(`k1:${k(1)}`).encrypt('x'))).toBe('k1');
    expect(ring.needsRotation(ring.encrypt('x'))).toBe(false);
    expect(ring.needsRotation(parseKeyring(`k1:${k(1)}`).encrypt('x'))).toBe(true);
  });

  it('refuses a value sealed with a key that was removed', () => {
    const sealed = parseKeyring(`k1:${k(1)}`).encrypt('x');
    expect(() => parseKeyring(`k2:${k(2)}`).decrypt(sealed)).toThrow(/k1/);
  });

  it('refuses tampered ciphertext', () => {
    const ring = parseKeyring(`k1:${k(1)}`);
    const parts = ring.encrypt('secret').split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => ring.decrypt(parts.join('.'))).toThrow();
  });

  it('uses a fresh IV every time', () => {
    const ring = parseKeyring(`k1:${k(1)}`);
    expect(ring.encrypt('same')).not.toBe(ring.encrypt('same'));
  });

  it.each([
    ['empty', ''],
    ['no id', k(1)],
    ['short key', `k1:${Buffer.alloc(16).toString('base64')}`],
    ['duplicate id', `k1:${k(1)},k1:${k(2)}`],
    ['bad id', `k 1:${k(1)}`],
  ])('rejects a malformed keyring (%s)', (_case, value) => {
    expect(() => parseKeyring(value)).toThrow();
  });

  it('never puts key material in its errors', () => {
    let message = '';
    try {
      parseKeyring(`k1:${Buffer.alloc(16, 7).toString('base64')}`);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(Buffer.alloc(16, 7).toString('base64'));
  });

  describe('bytes (stored files)', () => {
    const data = Buffer.from([0, 1, 2, 250, 255, 128, 7]);

    it('round-trips binary content and never keeps it readable', () => {
      const ring = parseKeyring(`k1:${k(1)}`);
      const sealed = ring.encryptBytes(data);
      expect(sealed.includes(data)).toBe(false);
      expect(ring.decryptBytes(sealed).equals(data)).toBe(true);
      expect(ring.keyIdOfBytes(sealed)).toBe('k1');
    });

    it('binds the content to its record: another aad, or none, fails to open', () => {
      const ring = parseKeyring(`k1:${k(1)}`);
      const sealed = ring.encryptBytes(data, Buffer.from('file-a'));
      expect(ring.decryptBytes(sealed, Buffer.from('file-a')).equals(data)).toBe(true);
      expect(() => ring.decryptBytes(sealed, Buffer.from('file-b'))).toThrow();
      expect(() => ring.decryptBytes(sealed)).toThrow();
    });

    it('detects altered content, a wrong format and a missing key', () => {
      const ring = parseKeyring(`k1:${k(1)}`);
      const sealed = ring.encryptBytes(data);
      const altered = Buffer.from(sealed);
      altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
      expect(() => ring.decryptBytes(altered)).toThrow();
      expect(() => ring.decryptBytes(Buffer.from('nope'))).toThrow('Unrecognized');
      expect(() => parseKeyring(`k2:${k(2)}`).decryptBytes(sealed)).toThrow('not in the keyring');
    });

    it('rotates: the old key still opens it, the new one seals, needsRotationBytes says so', () => {
      const old = parseKeyring(`k1:${k(1)}`).encryptBytes(data);
      const ring = parseKeyring(`k2:${k(2)},k1:${k(1)}`);
      expect(ring.needsRotationBytes(old)).toBe(true);
      const fresh = ring.encryptBytes(ring.decryptBytes(old));
      expect(ring.needsRotationBytes(fresh)).toBe(false);
    });
  });
});
