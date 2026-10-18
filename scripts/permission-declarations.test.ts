import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SPEC §4 layer 1, "default deny": every entry point states who may use it. A page, server action or API route
// without a guard call or an explicit `@permission` marker fails here.
const read = (file: string) => readFileSync(file, 'utf8');
const GUARD = /requirePagePermission\(|authorize\(|@permission\s+\S+/;

describe('every entry point declares its permission', () => {
  it.each(globSync('src/app/**/(protected)/**/page.tsx'))('protected page %s', (file) => {
    expect(read(file)).toMatch(GUARD);
  });

  it.each(globSync('src/**/*.{ts,tsx}').filter((f) => /^\s*['"]use server['"]/.test(read(f))))(
    'server action file %s',
    (file) => {
      expect(read(file)).toMatch(GUARD);
    },
  );

  it.each(globSync('src/app/api/**/route.ts'))('API route %s', (file) => {
    expect(read(file)).toMatch(/@permission\s+\S+/);
  });
});
