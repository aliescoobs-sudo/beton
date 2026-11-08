import { describe, expect, it } from 'vitest';
import { keyedHash } from './hmac';

const key = Buffer.alloc(32, 1).toString('base64');

describe('keyedHash', () => {
  it('is deterministic for the same key and value', () => {
    expect(keyedHash(key, 'owner@kayas.test')).toEqual(keyedHash(key, 'owner@kayas.test'));
  });

  it('depends on the key, so it cannot be recomputed without it', () => {
    expect(keyedHash(Buffer.alloc(32, 2).toString('base64'), 'x').equals(keyedHash(key, 'x'))).toBe(false);
  });

  it('returns 32 bytes that do not contain the value', () => {
    const digest = keyedHash(key, 'owner@kayas.test');
    expect(digest).toHaveLength(32);
    expect(digest.toString('utf8')).not.toContain('owner');
  });
});
