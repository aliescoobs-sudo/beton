import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Second factors, sessions, lockouts and the replay guard are judged against the REAL clock, never the simulated one:
// moving the simulation (days ahead, a scripted week) must not make a fresh authenticator code invalid or expire a session.
// Business code gets the simulated time through the request clock; the auth code must not touch it.
const AUTH_DIR = 'src/modules/platform-security/auth';
const SIMULATED_TIME =
  /\b(loadRequestClock|getRequestClock|readSimNow|syncSimClock|sim_now|sim_clock|ctx\.sim_)/;

describe('authentication uses the real clock only', () => {
  const files = readdirSync(AUTH_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('finds the auth sources', () => {
    expect(files).toContain('two-factor-hooks.ts');
    expect(files).toContain('create-auth.ts');
  });

  it.each(files)('%s never reads the simulated time', (file) => {
    expect(readFileSync(join(AUTH_DIR, file), 'utf8')).not.toMatch(SIMULATED_TIME);
  });

  it('wires the second-factor hooks with realClock', () => {
    expect(readFileSync(join(AUTH_DIR, 'create-auth.ts'), 'utf8')).toMatch(
      /twoFactorDeps\s*=\s*\{[^}]*clock:\s*realClock/,
    );
  });
});
