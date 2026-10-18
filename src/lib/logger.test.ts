import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('logger', () => {
  it('writes one JSON object per line with level and message', () => {
    const out = capture();
    createLogger({ write: out.write }).info('user logged in', { requestId: 'r1' });
    expect(JSON.parse(out.lines[0]!)).toEqual({ level: 'info', msg: 'user logged in', requestId: 'r1' });
  });

  it('redacts sensitive fields by name, at any depth', () => {
    const out = capture();
    createLogger({ write: out.write }).warn('login failed', {
      password: 'hunter2hunter2',
      user: { email: 'owner@example.test', Authorization: 'Bearer abc' },
      headers: { cookie: '__Host-session=xyz' },
      totpCode: '123456',
    });
    const entry = JSON.parse(out.lines[0]!);
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.user.email).toBe('[REDACTED]');
    expect(entry.user.Authorization).toBe('[REDACTED]');
    expect(entry.headers.cookie).toBe('[REDACTED]');
    expect(entry.totpCode).toBe('[REDACTED]');
  });

  it('scrubs registered secret values wherever they appear', () => {
    const out = capture();
    const secret = 'super-secret-key-value-123';
    const log = createLogger({ write: out.write, secretValues: [secret] });
    log.error(`connect failed with ${secret}`, { detail: `url=postgres://u:${secret}@db` });
    expect(out.lines.join('\n')).not.toContain(secret);
  });

  it('serializes errors without leaking registered secrets', () => {
    const out = capture();
    const secret = 'pw-in-connection-string';
    createLogger({ write: out.write, secretValues: [secret] }).error('boom', {
      error: new Error(`could not connect: ${secret}`),
    });
    const entry = JSON.parse(out.lines[0]!);
    expect(entry.error.message).toContain('could not connect');
    expect(out.lines[0]).not.toContain(secret);
  });

  it('adds a timestamp only when a time source is given', () => {
    const out = capture();
    createLogger({ write: out.write }).info('no clock');
    createLogger({ write: out.write, now: () => '2026-11-23T07:00:00.000Z' }).info('tick');
    expect(JSON.parse(out.lines[0]!).ts).toBeUndefined();
    expect(JSON.parse(out.lines[1]!).ts).toBe('2026-11-23T07:00:00.000Z');
  });
});
