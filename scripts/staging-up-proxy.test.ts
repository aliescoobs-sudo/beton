import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// T10i: scripts/staging/up.sh must FAIL, with one clear cause, when the proxy crash-loops or cannot read its files, and must check the files inside the
// container. The real up.sh runs in a throwaway directory with stub dc.sh / ops.sh / docker (their behaviour is set per scenario by files).
const PW_CANARY = 'canary-basic-password-0123456789';
const HASH_CANARY = '$2a$14$CANARYHASHCANARYHASHCANARYHASHCANARYHASHCANARYHASHCAN';
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const stubDc = `#!/usr/bin/env bash
echo "dc $*" >> calls.log
has() { [ -e "scenario/$1" ]; }
case "$1" in
  up-proxy) has proxy.up.fail && exit 1; exit 0 ;;
  logs) has proxy.denied && echo '{"level":"error","msg":"adapting config using caddyfile: Could not import /etc/caddy/staging/basic-auth.caddy: open /etc/caddy/staging/basic-auth.caddy: permission denied"}'; has proxy.denied && cat staging/basic-auth.caddy; has proxy.loop && echo restarting; exit 0 ;;
  exec) case "$*" in
      *"-T app wget"*) echo '{"status":"ready"}'; exit 0 ;;
      *"-T proxy sh -c"*) has proxy.unreadable && exit 1; exit 0 ;;
      *"-T proxy wget"*) has proxy.noconfig && exit 1; exit 0 ;;
    esac; exit 0 ;;
  ps) case "$*" in *proxy) has proxy.restarting && echo "proxy restarting unhealthy" || echo "proxy running healthy" ;; *) echo "app running healthy" ;; esac; exit 0 ;;
esac
exit 0
`;
const sandbox = (flags: string[] = []) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kayas-up-'));
  roots.push(root);
  for (const d of ['scripts/staging', 'staging', 'scenario', 'bin'])
    mkdirSync(path.join(root, d), { recursive: true });
  copyFileSync('scripts/staging/up.sh', path.join(root, 'scripts/staging/up.sh'));
  writeFileSync(path.join(root, 'scripts/staging/dc.sh'), stubDc, { mode: 0o755 });
  writeFileSync(
    path.join(root, 'scripts/staging/ops.sh'),
    '#!/usr/bin/env bash\necho "ops $*" >> calls.log\n',
    { mode: 0o755 },
  );
  writeFileSync(path.join(root, 'bin/docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(root, '.env.staging'), `STAGING_REHEARSAL=1\nBASIC_PASSWORD=${PW_CANARY}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(root, '.env.staging.ops'), 'X=1\n', { mode: 0o600 });
  writeFileSync(
    path.join(root, 'staging/basic-auth.caddy'),
    `basic_auth bcrypt "x" {\n\tu ${HASH_CANARY}\n}\n`,
    { mode: 0o644 },
  );
  chmodSync(path.join(root, 'scripts/staging/up.sh'), 0o755);
  for (const f of flags) writeFileSync(path.join(root, 'scenario', f), '');
  return (): { status: number | null; out: string } => {
    const r = spawnSync('bash', ['scripts/staging/up.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`,
        READY_SLEEP: '0',
        BOUNDARY_PAUSE: '0',
        PROXY_PAUSE: '0',
        HOME: root,
      } as unknown as NodeJS.ProcessEnv,
    });
    const out = r.stdout + r.stderr;
    // a hash or a password must never be printed, in any scenario
    expect(out).not.toContain(PW_CANARY);
    expect(out).not.toContain(HASH_CANARY);
    expect(out).not.toContain('CANARYHASH');
    return { status: r.status, out };
  };
};

describe('scripts/staging/up.sh: the proxy start is verified', () => {
  it('succeeds when the proxy starts, reads its files, has loaded its configuration and stays healthy', () => {
    const r = sandbox()();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('The staging stack is up');
  });
  it('names the permission-denied cause and the log command when the proxy crash-loops on an unreadable file, and prints no file content', () => {
    const r = sandbox(['proxy.up.fail', 'proxy.denied'])();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/permission denied/);
    expect(r.out).toMatch(/basic-auth\.caddy, which must be mode 0644/);
    expect(r.out).toContain('./scripts/staging/dc.sh logs --tail 30 proxy');
    expect(r.out).not.toContain('Could not import'); // the log line itself is not echoed
    expect(r.out).not.toContain('The staging stack is up');
  });
  it('fails with a clear message for any other crash loop / unhealthy proxy', () => {
    const r = sandbox(['proxy.up.fail', 'proxy.loop'])();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/restarting or unhealthy/);
    expect(r.out).toContain('logs --tail 30 proxy');
  });
  it('fails when the files are not readable inside the container, when Caddy has not loaded its configuration, and when the proxy is restarting after start', () => {
    for (const [flag, re] of [
      ['proxy.unreadable', /not readable inside the proxy container/],
      ['proxy.noconfig', /has not loaded its configuration/],
      ['proxy.restarting', /not running and healthy a few seconds after start/],
    ] as const) {
      const r = sandbox([flag])();
      expect(r.status, flag).toBe(1);
      expect(r.out, flag).toMatch(re);
      expect(r.out, flag).not.toContain('The staging stack is up');
    }
  });
});
