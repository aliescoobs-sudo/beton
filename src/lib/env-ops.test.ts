import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The ops secrets (superuser, backup role) sit in .env.ops precisely because Next.js does not load it.
describe('.env.ops is not loaded by Next.js', () => {
  it('loads .env but never .env.ops, in any mode', () => {
    const nextEnv = createRequire(createRequire(import.meta.url).resolve('next'))('@next/env') as {
      loadEnvConfig: (dir: string, dev: boolean, log?: unknown, forceReload?: boolean) => unknown;
    };
    const dir = mkdtempSync(join(tmpdir(), 'bb-env-'));
    try {
      writeFileSync(join(dir, '.env'), 'T24_APP_VAR=app\n');
      writeFileSync(join(dir, '.env.ops'), 'T24_OPS_VAR=ops\n');
      for (const dev of [true, false]) {
        delete process.env.T24_APP_VAR;
        delete process.env.T24_OPS_VAR;
        nextEnv.loadEnvConfig(dir, dev, { info: () => undefined, error: () => undefined }, true);
        expect(process.env.T24_APP_VAR).toBe('app');
        expect(process.env.T24_OPS_VAR).toBeUndefined();
      }
    } finally {
      delete process.env.T24_APP_VAR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
