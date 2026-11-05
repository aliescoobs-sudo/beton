import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// §16.10 as the lead worded it: a redirect after sign-in or step-up must stay on this origin. The cheapest way to keep that true is
// that no sign-in, enrolment or step-up code takes a destination from the request at all. Every redirect of the app is a fixed
// path built from the route's own locale; this test fails if a `next`/`returnTo`/`callbackUrl`-style destination ever appears.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });

describe('no destination is taken from the request (same-origin redirects only)', () => {
  const files = walk(join(process.cwd(), 'src'));
  it('reads no next / redirect / returnTo / callbackUrl parameter', () => {
    const offenders = files.filter((f) =>
      /searchParams\.get\(\s*['"](next|redirect|redirectTo|redirect_uri|returnTo|return_to|callbackUrl|continue|url)['"]/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
  it('every redirect() and router call after sign-in goes to a fixed path under the route locale', () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:(?<![.\w])redirect|router\.(?:push|replace))\(\s*([^)]*)\)/g)) {
        const arg = (m[1] ?? '').trim();
        // allowed: a template starting with the locale path, or the current path with a query string (dispatch board)
        if (!/^`\/\$\{locale\}/.test(arg) && !/^`\$\{pathname\}\?/.test(arg)) bad.push(`${f}: ${arg}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
