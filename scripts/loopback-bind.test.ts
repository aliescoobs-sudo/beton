import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// MEDIUM finding: `next dev` / `next start` listened on every interface. Only loopback; a reverse proxy fronts it.
describe('the web server listens on loopback only', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  it.each(['dev', 'start'])('pnpm %s binds 127.0.0.1', (name) => {
    expect(scripts[name]).toMatch(/(^| )-H 127\.0\.0\.1( |$)/);
  });

  it('the e2e web server binds 127.0.0.1', () => {
    expect(read('playwright.config.ts')).toMatch(/next start -H 127\.0\.0\.1 /);
  });

  it('no script starts next without the loopback bind', () => {
    for (const [name, command] of Object.entries(scripts)) {
      if (/next (dev|start)\b/.test(command)) expect(command, name).toMatch(/-H 127\.0\.0\.1/);
    }
  });
});
