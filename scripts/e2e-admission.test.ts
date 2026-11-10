import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertE2eTarget } from '../e2e/admission';

// R17 (T10d): the e2e setup only runs against the e2e target, and its sources are not in the runtime image's build context.
const ok = 'postgres://u:p@127.0.0.1:5432/belgobeton_e2e';
describe('e2e/global-setup admission', () => {
  it('admits the e2e database on a loopback host in a test environment', () => {
    expect(() =>
      assertE2eTarget({ NODE_ENV: 'test' }, [ok, 'postgres://u:p@localhost/belgobeton_e2e']),
    ).not.toThrow();
    expect(() => assertE2eTarget({}, [ok])).not.toThrow();
  });
  it.each([
    [{ NODE_ENV: 'production' }, [ok]],
    [{ APP_ENV: 'production' }, [ok]],
    [{ REAL_DATA: 'true' }, [ok]],
    [{}, ['postgres://u:p@db.example.com/belgobeton_e2e']],
    [{}, ['postgres://u:p@127.0.0.1/belgobeton']],
    [{}, ['postgres://u:p@127.0.0.1/belgobeton_test']],
    [{}, ['not a url']],
  ])('refuses %j with %j', (env, urls) => {
    expect(() => assertE2eTarget(env, urls)).toThrow(/e2e global setup refused/);
  });
  it('the runtime image build context excludes the e2e and test sources', () => {
    const ignore = readFileSync('.dockerignore', 'utf8')
      .split('\n')
      .map((l) => l.trim());
    for (const p of [
      'e2e',
      'tests',
      'playwright.config.ts',
      'vitest.config.ts',
      '**/*.test.ts',
      '**/*.int.test.ts',
    ])
      expect(ignore, p).toContain(p);
  });
});
