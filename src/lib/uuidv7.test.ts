import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuidv7';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7, variant 10 UUIDs', () => {
    expect(uuidv7(new Date('2026-11-23T07:00:00Z'))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the timestamp in the first 48 bits, so ids sort by creation time', () => {
    const id = uuidv7(new Date('2026-11-23T07:00:00.123Z'));
    const millis = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(millis).toBe(Date.parse('2026-11-23T07:00:00.123Z'));
    expect(uuidv7(new Date('2026-11-23T07:00:01Z')) > uuidv7(new Date('2026-11-23T07:00:00Z'))).toBe(true);
  });

  it('is unique for the same millisecond', () => {
    const at = new Date('2026-11-23T07:00:00Z');
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7(at))).size).toBe(1000);
  });
});
