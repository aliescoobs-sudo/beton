import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 }); // a cold CI runner pulls the caddy image on first use

// T10i / decision 228: the first real VPS crash-looped its proxy ("open /etc/caddy/basic-auth.caddy: permission denied") because make-basic.sh wrote the
// Basic Auth hash as 0600 owned by the deploy user, and the hardened proxy container (cap_drop ALL: its root has no DAC_OVERRIDE) is "other" to that file.
// The local macOS rehearsal missed it: Docker Desktop bind mounts mask ownership. This test runs the REAL caddy image with the proxy's security flags
// (docker-compose.staging.yml; pinned by the static test in scripts/staging-config.test.ts), on a file made by the REAL make-basic.sh and owned by a
// DIFFERENT uid, inside a named volume (a real Linux file system on every host, so ownership is not masked), and validates the REAL Caddyfile.staging.
// It needs Docker and the caddy image (pulled when absent). Without Docker it is skipped with a loud message, except in CI, where it must run.
const docker = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
if (!docker) {
  console.warn(
    '\n!!! staging-proxy-readability: DOCKER IS NOT AVAILABLE: the proxy-readability test is SKIPPED. This is the test that catches the unreadable Basic Auth hash.\n',
  );
}
const CADDY = 'caddy:2-alpine';
const OTHER_UID = '12345'; // not the container's root, not the file's "owner" as the container sees it
const PW = 'canary-basic-pw-0123456789';

const d = (args: string[], input?: string) =>
  spawnSync('docker', args, { encoding: 'utf8', input, timeout: 120_000 });

describe.skipIf(!docker && !process.env.CI)(
  'the hardened proxy can read the Basic Auth hash (real caddy image)',
  () => {
    if (!docker && process.env.CI) {
      it('docker must exist in CI', () => {
        throw new Error('Docker is required in CI for the staging proxy readability test');
      });
      return;
    }
    mkdirSync(path.resolve('.logs'), { recursive: true });
    const work = mkdtempSync(path.resolve('.logs/proxytest-'));
    const volumes: string[] = [];
    const containers: string[] = [];
    const rand = () => Math.random().toString(36).slice(2, 10);
    afterAll(() => {
      for (const c of containers) d(['rm', '-f', c]);
      for (const v of volumes) d(['volume', 'rm', '-f', v]);
      rmSync(work, { recursive: true, force: true });
    });

    // a throwaway copy of the repository layout make-basic.sh needs: scripts/staging/make-basic.sh and a staging/ directory (0755, as a git clone makes it)
    const makeBasic = (dir: string, user: string, replace = false) => {
      mkdirSync(path.join(dir, 'scripts/staging'), { recursive: true });
      mkdirSync(path.join(dir, 'staging'), { recursive: true, mode: 0o755 });
      spawnSync('chmod', ['755', path.join(dir, 'staging')]);
      copyFileSync('scripts/staging/make-basic.sh', path.join(dir, 'scripts/staging/make-basic.sh'));
      return spawnSync('bash', ['scripts/staging/make-basic.sh'], {
        cwd: dir,
        encoding: 'utf8',
        input: `${user}\n${PW}\n${PW}\n`,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? dir,
          KAYAS_BASIC_BATCH: '1',
          ...(replace ? { KAYAS_BASIC_REPLACE: '1' } : {}),
        } as unknown as NodeJS.ProcessEnv,
      });
    };
    const modeOf = (p: string) => statSync(p).mode & 0o777;

    // the file goes into a volume, owned by another uid, with the mode make-basic.sh produced (the directory as a clone makes it: 0755)
    const volumeWith = (file: string, fileMode: number) => {
      const v = `kayas-proxytest-${rand()}`;
      volumes.push(v);
      const r = d([
        'run',
        '--rm',
        '-v',
        `${v}:/v`,
        '-v',
        `${path.dirname(file)}:/src:ro`,
        CADDY,
        'sh',
        '-c',
        `cp /src/basic-auth.caddy /v/basic-auth.caddy && chown ${OTHER_UID}:${OTHER_UID} /v /v/basic-auth.caddy && chmod 755 /v && chmod ${fileMode.toString(8)} /v/basic-auth.caddy`,
      ]);
      expect(r.status, r.stderr).toBe(0);
      return v;
    };
    // the proxy's flags from docker-compose.staging.yml: <<: *hardening (no-new-privileges, cap_drop ALL), cap_add NET_BIND_SERVICE, read_only, tmpfs /tmp /config
    // (the compose has /data as a volume: a tmpfs here), the Caddyfile read-only, the staging directory read-only at /etc/caddy/staging, no `user:` (root).
    const validate = (volume: string) =>
      d([
        'run',
        '--rm',
        '--security-opt',
        'no-new-privileges:true',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'NET_BIND_SERVICE',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--tmpfs',
        '/config',
        '--tmpfs',
        '/data',
        '-e',
        'APP_DOMAIN=kayas.example.com',
        '-e',
        'STAGING_TLS=acme',
        '-e',
        'STAGING_HTTP_PORT=80',
        '-e',
        'STAGING_HTTPS_PORT=443',
        '-v',
        `${path.resolve('Caddyfile.staging')}:/etc/caddy/Caddyfile:ro`,
        '-v',
        `${volume}:/etc/caddy/staging:ro`,
        CADDY,
        'caddy',
        'validate',
        '--config',
        '/etc/caddy/Caddyfile',
      ]);

    it('control: a 0600 file owned by another uid is "permission denied" for the hardened proxy (the bug of the first VPS)', () => {
      const dir = path.join(work, 'control');
      expect(makeBasic(dir, 'ali-basic').status).toBe(0);
      const v = volumeWith(path.join(dir, 'staging/basic-auth.caddy'), 0o600);
      const r = validate(v);
      expect(r.status, 'the harness must be able to see the bug').not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/permission denied/);
    });

    it('the file make-basic.sh writes (any umask) is readable by the hardened proxy although another uid owns it, and the real Caddyfile validates', () => {
      const dir = path.join(work, 'fixed');
      const r = makeBasic(dir, 'ali-basic');
      expect(r.status, r.stderr).toBe(0);
      const file = path.join(dir, 'staging/basic-auth.caddy');
      const mode = modeOf(file);
      expect(mode & 0o004, 'world-readable').toBe(0o004);
      expect(mode & 0o022, 'not writable by group or others').toBe(0);
      expect(readFileSync(file, 'utf8')).not.toContain(PW); // a hash only
      const v = volumeWith(file, mode);
      const out = validate(v);
      expect(out.status, out.stdout + out.stderr).toBe(0);
      expect(out.stdout + out.stderr).toMatch(/Valid configuration/);
    });

    it('re-running make-basic.sh gives a NEW hash that a running container sees at once (a directory mount follows the rename; a single-file mount would not)', () => {
      const dir = path.join(work, 'stale');
      expect(makeBasic(dir, 'first-user').status).toBe(0);
      const c = `kayas-proxytest-c-${rand()}`;
      containers.push(c);
      const run = d([
        'run',
        '-d',
        '--name',
        c,
        '-v',
        `${path.join(dir, 'staging')}:/etc/caddy/staging:ro`,
        CADDY,
        'sleep',
        '120',
      ]);
      expect(run.status, run.stderr).toBe(0);
      const read = () => d(['exec', c, 'cat', '/etc/caddy/staging/basic-auth.caddy']).stdout;
      expect(read()).toContain('first-user');
      expect(makeBasic(dir, 'second-user', true).status).toBe(0);
      const after = read();
      expect(after).toContain('second-user');
      expect(after).not.toContain('first-user');
    });
  },
);
