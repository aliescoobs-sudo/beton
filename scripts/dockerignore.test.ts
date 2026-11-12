import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// R20-08: no test source (e2e, e2e-staging, *.spec.ts, *.test.ts, the playwright configs) may enter the runtime image. The Dockerfile does `COPY . .`, so
// .dockerignore is the only filter. This applies .dockerignore with Docker's rules (patterns relative to the context root; a match on a directory excludes
// everything below it; `**` crosses directories; the last matching pattern wins; `!` re-includes) to every file git tracks, plus the tracked-or-not paths named
// by the review, and fails if any test source would be copied.
const rules = readFileSync('.dockerignore', 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const neg = l.startsWith('!');
    const pat = (neg ? l.slice(1) : l).replace(/^\/+/, '').replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i]!;
      if (pat.startsWith('**/', i)) {
        re += '(?:.*/)?';
        i += 2;
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return { neg, re: new RegExp(`^${re}$`) };
  });
const excluded = (file: string): boolean => {
  const parts = file.split('/');
  for (let n = 1; n <= parts.length; n++) {
    const prefix = parts.slice(0, n).join('/');
    let hit: boolean | null = null;
    for (const r of rules) if (r.re.test(prefix)) hit = !r.neg;
    if (hit) return true;
  }
  return false;
};
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const isTestSource = (f: string) =>
  /(^|\/)(e2e|e2e-staging|tests)\//.test(f) ||
  /\.(test|spec)\.tsx?$/.test(f) ||
  /(^|\/)playwright(\.staging)?\.config\.ts$/.test(f);

describe('.dockerignore keeps test sources out of the runtime image (R20-08)', () => {
  it('the matcher itself works (positive and negative controls)', () => {
    expect(excluded('e2e-staging/basic-auth.spec.ts')).toBe(true);
    expect(excluded('src/a/b/x.test.ts')).toBe(true);
    expect(excluded('src/app/page.tsx')).toBe(false);
    expect(excluded('.env.staging.example')).toBe(false);
    expect(excluded('.env.staging')).toBe(true);
  });
  it('excludes every tracked test source, the staging browser tests and the playwright configs', () => {
    const leaked = tracked.filter((f) => isTestSource(f) && !excluded(f));
    expect(leaked).toEqual([]);
    for (const p of [
      'e2e-staging/basic-auth.spec.ts',
      'e2e-staging/new-file.ts',
      'playwright.staging.config.ts',
      'playwright.config.ts',
      'src/x/y.spec.ts',
      'e2e/anything.ts',
    ])
      expect(excluded(p), p).toBe(true);
  });
  it('the Dockerfile copies the whole context only through the filter (no explicit COPY of a test path)', () => {
    const df = readFileSync('Dockerfile', 'utf8');
    expect(df).not.toMatch(/COPY[^\n]*(e2e|playwright|\.spec\.)/);
    expect(df).toMatch(/^COPY \. \.$/m);
  });
});
