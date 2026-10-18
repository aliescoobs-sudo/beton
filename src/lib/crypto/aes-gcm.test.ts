import { describe, expect, it } from 'vitest';
import { decryptString, encryptString } from './aes-gcm';

const key = Buffer.alloc(32, 3).toString('base64');

describe('AES-256-GCM string encryption', () => {
  it('round-trips and never contains the plaintext', () => {
    const sealed = encryptString(key, '["ABCDE-12345"]');
    expect(sealed).not.toContain('ABCDE');
    expect(decryptString(key, sealed)).toBe('["ABCDE-12345"]');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptString(key, 'same')).not.toBe(encryptString(key, 'same'));
  });

  it('rejects tampered ciphertext', () => {
    const sealed = encryptString(key, 'secret');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
    expect(() => decryptString(key, tampered)).toThrow();
  });

  it('rejects the wrong key', () => {
    const sealed = encryptString(key, 'secret');
    expect(() => decryptString(Buffer.alloc(32, 4).toString('base64'), sealed)).toThrow();
  });
});
