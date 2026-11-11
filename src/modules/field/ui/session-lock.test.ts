import { describe, expect, it } from 'vitest';
import { FIELD_SESSION_LOCK, withFieldSessionLock } from './session-lock';

// R18-05: a Web Lock manager is a queue per name; this fake is one, so two "tabs" can be raced deterministically.
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  return {
    names,
    request<T>(name: string, _o: { mode: 'exclusive' }, cb: () => Promise<T>): Promise<T> {
      names.push(name);
      const run = tail.then(cb, cb);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

describe('R18-05: sign-in and sign-out requests of all tabs run one at a time', () => {
  it("a slow logout of tab A completes before tab B's login starts, so its answer cannot land after the login's cookie", async () => {
    const locks = fakeLocks();
    const events: string[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const logoutA = withFieldSessionLock(async () => {
      events.push('logout:start');
      await delay(40);
      events.push('logout:answer'); // the response (and its Set-Cookie) is applied here
    }, locks);
    const loginB = withFieldSessionLock(async () => {
      events.push('login:start');
      await delay(5);
      events.push('login:answer');
    }, locks);
    await Promise.all([logoutA, loginB]);
    expect(events).toEqual(['logout:start', 'logout:answer', 'login:start', 'login:answer']);
    expect(locks.names).toEqual([FIELD_SESSION_LOCK, FIELD_SESSION_LOCK]);
  });
  it('a failing request releases the lock for the next one', async () => {
    const locks = fakeLocks();
    await expect(
      withFieldSessionLock(async () => Promise.reject(new Error('network')), locks),
    ).rejects.toThrow('network');
    await expect(withFieldSessionLock(async () => 'ok', locks)).resolves.toBe('ok');
  });
  it('without Web Locks the request simply runs', async () => {
    await expect(withFieldSessionLock(async () => 7, undefined)).resolves.toBe(7);
  });
});
