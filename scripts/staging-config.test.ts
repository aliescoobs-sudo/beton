import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardened, IMG_A as GOOD, makeSandbox, OWNER, stagingConfig } from './ops-sandbox';

// T10g group A (R19B-01): the staging compose, the Caddyfile and the strict wrapper. The validator is run on hand-built effective configurations (so
// the test needs no Docker), and on the REAL `docker compose config` of the file when Docker is present.
const hasDocker = spawnSync('docker', ['compose', 'version']).status === 0;
const hasPython = spawnSync('python3', ['--version']).status === 0;
const inCi = !!process.env.CI; // in CI the suites below must run: a missing tool is a FAILURE, never a silent skip (R21)
it.runIf(inCi)('CI: python3 is available (the shell-script suites must not be skipped silently)', () => {
  expect(hasPython).toBe(true);
});
const goodConfig = stagingConfig;
it.runIf(inCi)(
  'CI: docker compose is available (the real-compose checks must not be skipped silently)',
  () => {
    expect(hasDocker).toBe(true);
  },
);
type Json = ReturnType<typeof stagingConfig>;
function validate(cfg: Json, args: string[] = ['--stack', 'staging', '--image', GOOD]) {
  const r = spawnSync('python3', ['-I', 'scripts/ops/validate-compose.py', ...args], {
    input: JSON.stringify(cfg),
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}

describe.skipIf(!hasPython && !inCi)('the effective-configuration validator (staging)', () => {
  it('accepts the expected configuration', () => {
    expect(validate(goodConfig())).toMatchObject({ code: 0 });
  });
  const hostile: [string, (c: Json) => void, RegExp][] = [
    [
      'another image for the app',
      (c) => (c.services.app.image = `ghcr.io/${OWNER}/kayas@sha256:${'b2'.repeat(32)}`),
      /app: image/,
    ],
    [
      'a tag instead of a digest for ops',
      (c) => (c.services.ops.image = `ghcr.io/${OWNER}/kayas:latest`),
      /ops: image/,
    ],
    ['another platform', (c) => (c.services.app.platform = 'linux/arm64'), /app: platform/],
    [
      'the app publishes a port',
      (c) =>
        (c.services.app.ports = [{ target: 3000, published: '3000', protocol: 'tcp', host_ip: '0.0.0.0' }]),
      /app: published ports/,
    ],
    [
      'the database publishes a port',
      (c) =>
        (c.services.db.ports = [{ target: 5432, published: '5432', protocol: 'tcp', host_ip: '0.0.0.0' }]),
      /db: published ports/,
    ],
    [
      'the proxy publishes an extra port',
      (c) =>
        c.services.proxy.ports?.push({
          target: 8080,
          published: '8080',
          protocol: 'tcp',
          host_ip: '0.0.0.0',
        }),
      /proxy: published ports/,
    ],
    [
      'the proxy binds a public IP explicitly',
      (c) => ((c.services.proxy.ports ?? [])[0]!.host_ip = '203.0.113.7'),
      /specific host address/,
    ],
    [
      'a host folder is mounted into ops (an importer mount)',
      (c) =>
        (c.services.ops.volumes = [
          { type: 'bind', source: '/home/x/imports', target: '/twin', read_only: true },
        ]),
      /ops: bind mount to \/twin/,
    ],
    [
      'the docker socket is mounted',
      (c) =>
        (c.services.app.volumes = [
          { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' },
        ]),
      /app: bind mount/,
    ],
    [
      'the Basic file is mounted writable',
      (c) => ((c.services.proxy.volumes ?? [])[1]!.read_only = false),
      /proxy: bind mount/,
    ],
    ['privileged', (c) => (c.services.app.privileged = true), /privileged/],
    ['host network', (c) => (c.services.app.network_mode = 'host'), /network_mode/],
    ['an extra capability', (c) => (c.services.app.cap_add = ['SYS_ADMIN']), /capabilities/],
    ['no cap_drop', (c) => (c.services.app.cap_drop = []), /cap_drop/],
    ['no no-new-privileges', (c) => (c.services.proxy.security_opt = []), /no-new-privileges/],
    ['no memory limit', (c) => delete c.services.db.mem_limit, /memory or pids/],
    ['unbounded logs', (c) => (c.services.app.logging = { driver: 'json-file' }), /bounded log/],
    ['writable root of the app', (c) => (c.services.app.read_only = false), /read-only root/],
    [
      'an unexpected service',
      (c) => (c.services.lan = hardened({ image: 'caddy:2-alpine' })),
      /lan: unexpected service/,
    ],
    ['real data on', (c) => (c.services.app.environment.REAL_DATA = 'true'), /REAL_DATA/],
    ['training off', (c) => (c.services.app.environment.TRAINING_MODE = 'false'), /TRAINING_MODE/],
    [
      'the staging profile off',
      (c) => (c.services.app.environment.STAGING_PROFILE = 'false'),
      /STAGING_PROFILE/,
    ],
    [
      'a provider key in the environment',
      (c) => (c.services.app.environment.ANTHROPIC_API_KEY = 'x'),
      /ANTHROPIC_API_KEY must be absent/,
    ],
    [
      'a push key in the environment',
      (c) => (c.services.ops.environment.VAPID_PRIVATE_KEY = 'x'),
      /VAPID_PRIVATE_KEY must be absent/,
    ],
    ['the internal network is not internal', (c) => (c.networks.internal!.internal = false), /not internal/],
    ['another compose project', (c) => (c.name = 'kayas'), /project/],
  ];
  for (const [name, mutate, re] of hostile) {
    it(`refuses: ${name}`, () => {
      const cfg = goodConfig();
      mutate(cfg);
      const r = validate(cfg);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(re);
    });
  }
  it('never prints an environment value', () => {
    const cfg = goodConfig();
    cfg.services.app.environment.AUTH_SECRET = 'CANARY-SECRET-VALUE';
    cfg.services.app.environment.REAL_DATA = 'CANARY-WRONG';
    expect(validate(cfg).err).not.toContain('CANARY');
  });
  it('refuses a local image id unless it is the rehearsal, and a rehearsal port that is not loopback', () => {
    const id = `sha256:${'c3'.repeat(32)}`;
    expect(validate(goodConfig(id), ['--stack', 'staging', '--image', id]).code).toBe(2);
    const cfg = goodConfig(id);
    cfg.services.proxy.ports = [18080, 18443].map((p) => ({
      target: p,
      published: String(p),
      protocol: 'tcp',
      host_ip: '127.0.0.1',
    }));
    cfg.services.proxy.environment.STAGING_HTTPS_PORT = '18443';
    cfg.services.proxy.environment.STAGING_TLS = 'internal';
    cfg.services.app.environment.APP_BASE_URL = 'https://kayas.example.com:18443';
    expect(validate(cfg, ['--stack', 'staging', '--image', id, '--rehearsal']).code).toBe(0);
    (cfg.services.proxy.ports ?? [])[0]!.host_ip = '0.0.0.0';
    expect(validate(cfg, ['--stack', 'staging', '--image', id, '--rehearsal']).code).toBe(1);
  });
});

describe.skipIf((!hasDocker || !hasPython) && !inCi)('the real staging compose file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-staging-'));
  const env = `APP_DOMAIN=kayas.example.com\nAPP_IMAGE=${GOOD}\nAPP_BASE_URL=https://kayas.example.com\nPOSTGRES_SUPERUSER_PASSWORD=x\n`;
  writeFileSync(path.join(dir, '.env.staging'), env);
  writeFileSync(path.join(dir, '.env.staging.ops'), 'POSTGRES_SUPERUSER_PASSWORD=x\n');
  copyFileSync('docker-compose.staging.yml', path.join(dir, 'docker-compose.staging.yml'));
  const config = (extraEnv: Record<string, string> = {}) =>
    spawnSync(
      'docker',
      [
        'compose',
        '-f',
        path.join(dir, 'docker-compose.staging.yml'),
        '--project-directory',
        dir,
        '--env-file',
        path.join(dir, '.env.staging'),
        '--env-file',
        path.join(dir, '.env.staging.ops'),
        '--profile',
        'ops',
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', env: { ...process.env, APP_IMAGE: GOOD, ...extraEnv } },
    );
  it('resolves to a configuration the validator accepts (80/443, hardened, no importer mount)', () => {
    const r = config();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const v = spawnSync(
      'python3',
      ['-I', 'scripts/ops/validate-compose.py', '--stack', 'staging', '--image', GOOD],
      { input: r.stdout, encoding: 'utf8' },
    );
    expect(v.stderr).toContain('accepted');
    expect(v.status).toBe(0);
    const cfg = JSON.parse(r.stdout) as Json;
    for (const [name, s] of Object.entries(cfg.services)) {
      expect(s.cap_drop, name).toContain('ALL');
      expect(s.security_opt, name).toContain('no-new-privileges:true');
      expect(Number(s.mem_limit), name).toBeGreaterThan(0);
      expect(Number(s.pids_limit), name).toBeGreaterThan(0);
      expect(s.logging?.options?.['max-size'], name).toBe('10m');
      expect(s.volumes?.filter((x) => x.type === 'bind').length ?? 0, name).toBeLessThanOrEqual(2);
    }
    expect(Object.keys(cfg.services).sort()).toEqual(['app', 'db', 'ops', 'proxy']);
    const memory = Object.entries(cfg.services)
      .filter(([n]) => n !== 'ops')
      .reduce((a, [, s]) => a + Number(s.mem_limit), 0);
    expect(memory).toBeLessThanOrEqual(3.4 * 1024 ** 3); // db + app + proxy leave room on a 4 GB host
    expect(cfg.services.app.environment.TRAINING_MODE).toBe('true');
    expect(cfg.services.app.environment.TRUSTED_PROXY_HOPS).toBe('1');
    expect(cfg.services.app.environment.APP_BASE_URL).toBe('https://kayas.example.com');
    expect(cfg.services.proxy.environment.APP_DOMAIN).toBe('kayas.example.com');
  });
  it('a hostile shell cannot widen the effective configuration (the validator would refuse it)', () => {
    // an environment variable the file reads: a different bind address for the proxy
    const r = config({ STAGING_BIND_IP: '203.0.113.9' });
    const v = spawnSync(
      'python3',
      ['-I', 'scripts/ops/validate-compose.py', '--stack', 'staging', '--image', GOOD],
      { input: r.stdout, encoding: 'utf8' },
    );
    expect(v.status).toBe(1);
    expect(v.stderr).toMatch(/specific host address/);
    const r2 = config({ STAGING_HTTP_PORT: '8080' });
    expect(
      spawnSync('python3', ['-I', 'scripts/ops/validate-compose.py', '--stack', 'staging', '--image', GOOD], {
        input: r2.stdout,
        encoding: 'utf8',
      }).status,
    ).toBe(1);
  });
  it('the Caddyfile adapts for Caddy: ACME by default, the internal CA only when asked, anything else fails closed (needs the caddy image locally)', () => {
    let have = spawnSync('docker', ['image', 'inspect', 'caddy:2-alpine']).status === 0;
    if (!have && inCi) have = spawnSync('docker', ['pull', 'caddy:2-alpine']).status === 0; // in CI the image is pulled, and its absence is a failure
    if (!have && inCi)
      throw new Error('CI: the caddy:2-alpine image is required for the Caddyfile adaptation check');
    if (!have) return; // locally: skipped when the image is not there
    mkdirSync(path.resolve('.logs'), { recursive: true });
    const gateDir = mkdtempSync(path.resolve('.logs', 'gate-'));
    chmodSync(gateDir, 0o755);
    copyFileSync('staging/basic-auth.caddy.example', path.join(gateDir, 'basic-auth.caddy'));
    chmodSync(path.join(gateDir, 'basic-auth.caddy'), 0o644);
    const adapt = (tls?: string) =>
      spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '-e',
          'APP_DOMAIN=kayas.example.com',
          ...(tls === undefined ? [] : ['-e', `STAGING_TLS=${tls}`]),
          '-v',
          `${path.resolve('Caddyfile.staging')}:/etc/caddy/Caddyfile:ro`,
          '-v',
          `${gateDir}:/etc/caddy/staging:ro`,
          'caddy:2-alpine',
          'caddy',
          'adapt',
          '--config',
          '/etc/caddy/Caddyfile',
        ],
        { encoding: 'utf8' },
      );
    const def = adapt();
    expect(def.status).toBe(0);
    expect(def.stdout).not.toContain('"module":"internal"');
    expect(def.stdout).toContain('"handler":"authentication"');
    expect(adapt('acme').stdout).not.toContain('"module":"internal"');
    expect(adapt('internal').stdout).toContain('"module":"internal"');
    expect(adapt('bogus').status).not.toBe(0);
    rmSync(gateDir, { recursive: true, force: true });
  });
});

describe('the Caddyfile and the files as text', () => {
  const caddy = readFileSync('Caddyfile.staging', 'utf8');
  const compose = readFileSync('docker-compose.staging.yml', 'utf8');
  const lines = caddy.split('\n').filter((l) => !l.trim().startsWith('#'));
  const code = lines.join('\n');
  it('puts the Basic Auth import before the reverse proxy, inside one route, with no path exemption', () => {
    const imp = code.indexOf('import /etc/caddy/staging/basic-auth.caddy');
    const rp = code.indexOf('reverse_proxy');
    expect(imp).toBeGreaterThan(0);
    expect(rp).toBeGreaterThan(imp);
    expect(code.indexOf('route {')).toBeLessThan(imp);
    // the only matcher is the health path that is answered with 404 AFTER the gate
    expect(code.match(/^\s*@\w+/gm)?.map((m) => m.trim())).toEqual(['@internal']);
    expect(code).toMatch(/@internal path \/api\/health\/\*\n\s*respond @internal 404/);
    // exactly one reverse_proxy, one site for the domain
    expect(code.match(/reverse_proxy/g)).toHaveLength(1);
    expect(code.match(/\{\$APP_DOMAIN\} \{/g)).toHaveLength(1);
  });
  it('writes no access log, drops the client Authorization header, overwrites X-Forwarded-*', () => {
    expect(code).not.toMatch(/^\s*log\s+\w*\s*\{[^}]*access/m);
    expect(code).not.toMatch(/^\s*(output file|format json)/m);
    expect(code).toContain('header_up -Authorization');
    expect(code).toContain('header_up X-Forwarded-For {remote_host}');
    expect(code).toContain('admin off');
    expect(code).toMatch(/request_body \{\s*max_size/);
    expect(code).toMatch(/read_header/);
  });
  it('repeats the security headers for Caddy-generated errors and removes the Server header', () => {
    expect(code).toMatch(
      /handle_errors \{[\s\S]*Strict-Transport-Security[\s\S]*X-Content-Type-Options[\s\S]*-Server/,
    );
  });
  it('keeps the hash out of every environment file and variable', () => {
    expect(compose).not.toMatch(/\$2[aby]\$/);
    expect(compose).not.toMatch(/^\s*[A-Z_]*BASIC[A-Z_]*:/m); // no Basic Auth variable; the hash is a mounted file
    expect(readFileSync('.env.staging.example', 'utf8')).not.toMatch(/\$2[aby]\$/);
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\/staging\/basic-auth\.caddy$/m);
  });
  it('has no provider, push, map, importer or LAN configuration', () => {
    const noComments = compose
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(noComments).not.toMatch(/ANTHROPIC|VAPID|MAPS|lan-proxy|Caddyfile\.lan|\/twin|imports|OPS_TWIN/i);
    expect(readFileSync('.env.staging.example', 'utf8')).not.toMatch(/ANTHROPIC_API_KEY=|VAPID_\w+=/);
    expect(noComments).toContain("REAL_DATA: 'false'");
    expect(noComments).toContain("STAGING_PROFILE: 'true'");
  });
});

describe('the proxy flags, the Basic Auth hash mode and the readability test stay consistent (decision 228)', () => {
  const compose = readFileSync('docker-compose.staging.yml', 'utf8');
  const from = compose.indexOf('\n  proxy:');
  const rest = compose.slice(from + 1);
  const next = rest.slice(rest.indexOf('\n') + 1).search(/\n {2}[a-z][a-z-]*:\n|\nvolumes:/);
  const proxyBlock = next < 0 ? rest : rest.slice(0, rest.indexOf('\n') + 1 + next);
  const code = (t: string) =>
    t
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
  it('the proxy is hardened, runs as the image root without DAC_OVERRIDE, and mounts the DIRECTORY of the hash read-only', () => {
    const p = code(proxyBlock);
    expect(p).toContain('<<: *hardening');
    expect(code(compose)).toMatch(/x-hardening: &hardening[\s\S]*?cap_drop: \[ALL\]/);
    expect(p).toMatch(/cap_add: \[NET_BIND_SERVICE\]/);
    expect(p).toMatch(/read_only: true/);
    expect(p).not.toMatch(/DAC_OVERRIDE|DAC_READ_SEARCH|privileged|^\s+user:/m);
    expect(p).toContain('./staging:/etc/caddy/staging:ro');
    expect(p).not.toMatch(/basic-auth\.caddy:\/etc/); // a single-file mount keeps the OLD inode after make-basic.sh renames a new file into place
    expect(code(readFileSync('Caddyfile.staging', 'utf8'))).toContain(
      'import /etc/caddy/staging/basic-auth.caddy',
    );
  });
  it('make-basic.sh writes a file the proxy can read (0644); dc.sh requires world-readable and not group/world-writable (so 0644 and 0444 pass, 0600/0640/0664 do not); the Docker test uses the same flags', () => {
    const mk = code(readFileSync('scripts/staging/make-basic.sh', 'utf8'));
    expect(mk).toMatch(/chmod 644 "\$tmp"/);
    expect(mk).not.toMatch(/chmod 600 "\$tmp"/);
    expect(mk).toMatch(/force-recreate --wait proxy/); // a running proxy keeps the old inode and hash otherwise
    const dcsh = code(readFileSync('scripts/staging/dc.sh', 'utf8'));
    expect(dcsh).toContain('must be mode 0644');
    const t = readFileSync('tests/staging-proxy-readability.int.test.ts', 'utf8').replace(/\s+/g, ' ');
    for (const flag of [
      "'--cap-drop', 'ALL'",
      "'--cap-add', 'NET_BIND_SERVICE'",
      "'--read-only'",
      'no-new-privileges:true',
    ])
      expect(t).toContain(flag);
    expect(t).not.toMatch(/'--cap-add', 'DAC|'--user'|'--privileged'/);
  });
});

describe('docs/STAGING-VPS.md: the registry-credential check prints verdict words only', () => {
  const guide = readFileSync('docs/STAGING-VPS.md', 'utf8');
  const start = guide.indexOf("python3 -c '\n") + "python3 -c '\n".length;
  const code = guide.slice(start, guide.indexOf("'\n", start));
  const run = (config?: string) => {
    const home = mkdtempSync(path.join(tmpdir(), 'kayas-auths-'));
    if (config !== undefined) {
      mkdirSync(path.join(home, '.docker'));
      writeFileSync(path.join(home, '.docker/config.json'), config);
    }
    const r = spawnSync('python3', ['-c', code], {
      encoding: 'utf8',
      env: { HOME: home, PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv,
    });
    rmSync(home, { recursive: true, force: true });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  it.skipIf(!hasPython && !inCi)(
    'empty, absent, stored, helper and unreadable configurations give the right verdict and never print a value',
    () => {
      expect(run('{"auths":{}}')).toMatchObject({ status: 0 });
      expect(run('{"auths":{}}').out).toMatch(/auths: empty[\s\S]*credsStore: none[\s\S]*credHelpers: none/);
      expect(run()).toMatchObject({ status: 0 });
      const stored = run('{"auths":{"ghcr.io":{"auth":"SECRET-CANARY-VALUE"}}}');
      expect(stored.status).toBe(1);
      expect(stored.out).toMatch(/NOT EMPTY/);
      expect(stored.out).not.toContain('SECRET-CANARY-VALUE');
      expect(run('{"auths":{},"credsStore":"desktop"}').out).toMatch(/credsStore: CONFIGURED/);
      expect(run('{"auths":{},"credHelpers":{"ghcr.io":"x"}}').out).toMatch(/credHelpers: CONFIGURED/);
      expect(run('not json').status).toBe(1);
    },
  );
});

describe('scripts/staging/make-basic.sh removes its own stale temporaries on start', () => {
  it('removes .basic-auth.XXXXXX leftovers only, nothing else', () => {
    const s = makeSandbox({ stack: 'staging' });
    s.write('staging/.basic-auth.Ab3dE9', 'old hash leftover\n', 0o644);
    s.write('staging/.basic-auth.zzzzzz', 'old hash leftover\n', 0o600);
    s.write('staging/.basic-auth.short', 'not ours\n', 0o600);
    s.write('staging/notes.txt', 'not ours\n', 0o600);
    const r = s.run(
      'scripts/staging/make-basic.sh',
      [],
      { KAYAS_BASIC_BATCH: '1', KAYAS_BASIC_REPLACE: '1' },
      'ali-basic\ncanary-stale-pw-0123456789\ncanary-stale-pw-0123456789\n',
    );
    expect(r.status, r.stderr).toBe(0);
    const left = readdirSync(path.join(s.root, 'staging')).sort();
    expect(left).not.toContain('.basic-auth.Ab3dE9');
    expect(left).not.toContain('.basic-auth.zzzzzz');
    expect(left).toContain('.basic-auth.short');
    expect(left).toContain('notes.txt');
    expect(left).toContain('basic-auth.caddy');
  });
});

describe('scripts/staging/make-basic.sh: a rotation is reported applied only when it is (R21-01)', () => {
  const PW = 'canary-rotation-pw-0123456789';
  const HASH = '$2a$14$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
  const rotate = (s: ReturnType<typeof makeSandbox>) =>
    s.run(
      'scripts/staging/make-basic.sh',
      [],
      { KAYAS_BASIC_BATCH: '1', KAYAS_BASIC_REPLACE: '1' },
      `ali-basic\n${PW}\n${PW}\n`,
    );
  const quiet = (r: { stdout: string; stderr: string }) => {
    expect(r.stdout + r.stderr).not.toContain(PW);
    expect(r.stdout + r.stderr).not.toContain(HASH);
  };
  const NOT_APPLIED =
    /rotation NOT applied: the old Basic credential may still work; do not rely on it; verify with the curl checks of docs\/STAGING-VPS\.md/;
  it('a FAILED status query is a non-zero "rotation NOT applied", never "not running"', () => {
    const s = makeSandbox({ stack: 'staging' });
    s.write('fail.1', 'ps -q proxy');
    const r = rotate(s);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(NOT_APPLIED);
    expect(r.stdout + r.stderr).not.toMatch(/no proxy is running|not running/);
    expect(s.called()).not.toMatch(/force-recreate/);
    quiet(r);
  });
  it('a FAILED recreation is a non-zero "rotation NOT applied"', () => {
    const s = makeSandbox({ stack: 'staging' });
    s.write('proxy.id', 'abc123\n');
    s.write('fail.1', 'force-recreate');
    const r = rotate(s);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(NOT_APPLIED);
    expect(r.stderr).toMatch(/could not be recreated/);
    quiet(r);
  });
  it('a recreation that is not confirmed running and healthy is a non-zero "rotation NOT applied"', () => {
    for (const state of ['proxy restarting unhealthy', 'proxy running starting', '']) {
      const s = makeSandbox({ stack: 'staging' });
      s.write('proxy.id', 'abc123\n');
      s.write('proxy.state', `${state}\n`);
      const r = rotate(s);
      expect(r.status, state).toBe(1);
      expect(r.stderr, state).toMatch(NOT_APPLIED);
      expect(r.stderr, state).toMatch(/not confirmed running and healthy/);
      quiet(r);
    }
  });
  it('a SUCCESSFUL query with an empty answer says the proxy is not running and exits 0', () => {
    const s = makeSandbox({ stack: 'staging' });
    const r = rotate(s);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/status query succeeded and no proxy is running/);
    expect(s.called()).not.toMatch(/force-recreate/);
    quiet(r);
  });
  it('a successful rotation recreates the proxy through the wrapper, confirms it, and exits 0', () => {
    const s = makeSandbox({ stack: 'staging' });
    s.write('proxy.id', 'abc123\n');
    const r = rotate(s);
    expect(r.status, r.stderr).toBe(0);
    expect(s.called()).toMatch(/up -d --force-recreate --wait proxy/);
    expect(r.stdout).toMatch(/rotation applied/);
    expect(r.stdout).toMatch(/OLD password must give 401/);
    quiet(r);
  });
});

describe.skipIf(!hasPython && !inCi)('scripts/staging/dc.sh (the release-bound wrapper)', () => {
  const stg = (o: Parameters<typeof makeSandbox>[0] = {}) => makeSandbox({ stack: 'staging', ...o });
  it('runs a valid command with the approved image', () => {
    const s = stg();
    const r = s.run('scripts/staging/dc.sh', ['ps']);
    expect(r.stderr).toContain('accepted');
    expect(r.status).toBe(0);
    expect(s.called()).toContain('config --format json');
    expect(s.called()).toMatch(/compose -f docker-compose\.staging\.yml .* ps/);
  });
  it('refuses an APP_IMAGE or COMPOSE_* exported in the shell, before any docker call', () => {
    const s = stg();
    expect(s.run('scripts/staging/dc.sh', ['ps'], { APP_IMAGE: 'evil/shell:latest' }).stderr).toMatch(
      /APP_IMAGE is set in the shell/,
    );
    expect(s.run('scripts/staging/dc.sh', ['ps'], { COMPOSE_FILE: 'evil.yml' }).stderr).toMatch(
      /COMPOSE_FILE is set/,
    );
    expect(s.called()).toBe('');
  });
  it('refuses an APP_IMAGE in either env file, an option before the sub-command, and down -v', () => {
    const s = stg();
    s.write('.env.staging', `APP_DOMAIN=kayas.example.com\nAPP_IMAGE=${GOOD}\n`);
    expect(s.run('scripts/staging/dc.sh', ['ps']).stderr).toMatch(/sets APP_IMAGE/);
    s.write('.env.staging', 'APP_DOMAIN=kayas.example.com\n');
    s.write('.env.staging.ops', `X=1\nAPP_IMAGE=${GOOD}\n`);
    expect(s.run('scripts/staging/dc.sh', ['ps']).stderr).toMatch(/sets APP_IMAGE/);
    s.write('.env.staging.ops', 'X=1\n');
    expect(s.run('scripts/staging/dc.sh', ['-f', 'evil.yml', 'ps']).stderr).toMatch(
      /not an allowed first argument/,
    );
    expect(s.run('scripts/staging/dc.sh', ['down', '-v']).stderr).toMatch(/refused/);
    expect(s.called()).toBe('');
  });
  it('refuses rehearsal-only settings without the rehearsal flag', () => {
    const s = stg();
    s.write('.env.staging', 'APP_DOMAIN=kayas.example.com\nSTAGING_HTTP_PORT=8080\n');
    expect(s.run('scripts/staging/dc.sh', ['ps']).stderr).toMatch(/rehearsal-only/);
  });
  it('R20-09: refuses inherited proxy / TLS / rehearsal / image overrides in the shell, before any docker call', () => {
    const overrides: Record<string, string>[] = [
      { APP_DOMAIN: 'evil.example.com' },
      { STAGING_TLS: 'internal' },
      { STAGING_HTTPS_PORT: '8443' },
      { STAGING_BIND_IP: '127.0.0.1' },
      { STAGING_REHEARSAL: '1' },
      { REHEARSAL_IMAGE: `sha256:${'a'.repeat(64)}` },
      { APP_BASE_URL: 'https://evil.example.com' },
      { AUTH_SECRET: 'shell-wins-over-file' }, // defined in .env.staging: the shell would override it
      { DOCKER_CONFIG: '/tmp/x' },
    ];
    for (const env of overrides) {
      const s = stg();
      const r = s.run('scripts/staging/dc.sh', ['ps'], env);
      expect(r.status, JSON.stringify(Object.keys(env))).toBe(1);
      expect(r.stderr).toMatch(/is set in the shell/);
      expect(s.called()).toBe('');
    }
  });
  it('R20-09: a multi-line / config-token host name, the internal CA and a mismatched origin are refused before any container call', () => {
    const bad: Record<string, (c: ReturnType<typeof stagingConfig>) => void> = {
      'a multi-line host name': (c) => {
        c.services.proxy.environment.APP_DOMAIN = 'kayas.example.com\nevil.example.com {\n\trespond 200';
      },
      'a trailing newline': (c) => {
        c.services.proxy.environment.APP_DOMAIN = 'kayas.example.com\n';
      },
      'a config token in the host name': (c) => {
        c.services.proxy.environment.APP_DOMAIN = 'kayas.example.com {';
      },
      'an uppercase / scheme host name': (c) => {
        c.services.proxy.environment.APP_DOMAIN = 'https://kayas.example.com';
      },
      'no dot': (c) => {
        c.services.proxy.environment.APP_DOMAIN = 'localhost';
      },
      'the internal CA on the VPS profile': (c) => {
        c.services.proxy.environment.STAGING_TLS = 'internal';
      },
      'an unknown TLS mode': (c) => {
        c.services.proxy.environment.STAGING_TLS = 'off';
      },
      'a different origin': (c) => {
        c.services.app.environment.APP_BASE_URL = 'https://other.example.com';
      },
      'an http origin': (c) => {
        c.services.app.environment.APP_BASE_URL = 'http://kayas.example.com';
      },
      'an origin with a port on the VPS': (c) => {
        c.services.app.environment.APP_BASE_URL = 'https://kayas.example.com:8443';
      },
    };
    for (const [name, mutate] of Object.entries(bad)) {
      const cfg = stagingConfig();
      mutate(cfg);
      const s = stg({ config: cfg });
      const r = s.run('scripts/staging/dc.sh', ['run', '--rm', 'ops']);
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(/REFUSED (proxy|app)/);
      expect(s.called(), name).not.toMatch(/run --rm/);
    }
    const ok = stg({ config: stagingConfig() }).run('scripts/staging/dc.sh', ['ps']);
    expect(ok.status).toBe(0); // valid generated inputs pass
  }, 90_000);
  it('refuses when the effective configuration is not the expected one, before anything runs', () => {
    const cfg = stagingConfig();
    cfg.services.ops.volumes = [{ type: 'bind', source: '/home/x', target: '/twin', read_only: true }];
    const s = stg({ config: cfg });
    const r = s.run('scripts/staging/dc.sh', ['run', '--rm', 'ops']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED ops: bind mount/);
    expect(s.called()).not.toMatch(/run --rm/);
  });
  it('allow-lists the options of run: no volume, env, entrypoint or privilege can be added', () => {
    const s = stg();
    for (const bad of [
      ['-v', '/:/host'],
      ['-e', 'A=1'],
      ['--entrypoint', 'sh'],
      ['--privileged'],
      ['--network', 'host'],
      ['--cap-add', 'SYS_ADMIN'],
      ['--user', 'root'],
    ]) {
      const r = s.run('scripts/staging/dc.sh', ['run', ...bad, 'ops', 'true']);
      if (bad[0] === '--user')
        expect(r.status).toBe(0); // root with the CHOWN/FOWNER jobs is the one allowed form for staging
      else expect(r.status, bad.join(' ')).toBe(1);
    }
    expect(
      s
        .calls()
        .filter((c) => / run /.test(c))
        .every((c) => !/-v \/:\/host|--privileged|--entrypoint/.test(c)),
    ).toBe(true);
  });
  it('R21-02: every `up` that could start the proxy runs the hash/directory gate BEFORE the container-creating call; only an explicit db/app/ops list skips it', () => {
    const mayStartProxy: string[][] = [
      ['up'],
      ['up', '-d'],
      ['up', '-d', '--wait'],
      ['up', '-d', 'proxy'],
      ['up', '-d', '--wait', '--wait-timeout', '60'],
      ['up', '-d', '--wait-timeout=60'],
      ['up', '-d', '-t', '60'],
      ['up', '-d', '--scale', 'proxy=1'],
      ['up', '-d', '--scale', 'proxy=1', 'db'],
      ['up', '-d', '--bogus', 'db'],
      ['up', '-d', 'db', 'proxy'],
      ['up', '-d', 'db', 'unknown-service'],
      ['up-proxy'],
    ];
    const dbOnly: string[][] = [
      ['up', '-d', '--wait', 'db'],
      ['up', '-d', 'db', 'app'],
      ['up', '-d', '--wait', 'app'],
    ];
    const containerCalls = (s: { calls: () => string[] }) =>
      s.calls().filter((c) => / up /.test(` ${c}`) && !/config --format json/.test(c));
    // unsafe gates: 0600, wrong owner (stub id), group-writable, a link
    const unsafe: [string, (s: ReturnType<typeof makeSandbox>) => void][] = [
      ['0600', (s) => chmodSync(path.join(s.root, 'staging/basic-auth.caddy'), 0o600)],
      ['group-writable', (s) => chmodSync(path.join(s.root, 'staging/basic-auth.caddy'), 0o664)],
      [
        'wrong owner',
        (s) => writeFileSync(path.join(s.root, 'bin/id'), '#!/bin/sh\necho 424242\n', { mode: 0o755 }),
      ],
      [
        'symlink',
        (s) => {
          spawnSync('rm', ['-f', path.join(s.root, 'staging/basic-auth.caddy')]);
          symlinkSync('/etc/hostname', path.join(s.root, 'staging/basic-auth.caddy'));
        },
      ],
    ];
    for (const [name, spoil] of unsafe)
      for (const args of mayStartProxy) {
        const s = stg();
        spoil(s);
        const r = s.run('scripts/staging/dc.sh', args);
        expect(r.status, `${name}: ${args.join(' ')}`).toBe(1);
        expect(containerCalls(s), `${name}: ${args.join(' ')}`).toEqual([]);
      }
    // the first start (database / app only) works without any hash file; the same forms with a good gate work too
    for (const args of dbOnly) {
      const s = stg();
      spawnSync('rm', ['-f', path.join(s.root, 'staging/basic-auth.caddy')]);
      expect(s.run('scripts/staging/dc.sh', args).status, args.join(' ')).toBe(0);
      expect(containerCalls(s).length, args.join(' ')).toBe(1);
    }
    for (const args of mayStartProxy) {
      const s = stg();
      expect(s.run('scripts/staging/dc.sh', args).status, `good gate: ${args.join(' ')}`).toBe(0);
    }
  }, 180_000);
  it('the staging/ directory the proxy sees holds only documented files and the helper temporaries; the offending NAME (never content) is reported', () => {
    const allowed = ['README.md', 'basic-auth.caddy.example', '.basic-auth.Ab3dE9', '.basic-auth.123456'];
    for (const name of allowed) {
      const s = stg();
      s.write(`staging/${name}`, 'x\n', 0o644);
      expect(s.run('scripts/staging/dc.sh', ['up-proxy']).status, name).toBe(0);
    }
    const refused = [
      'backup.sql',
      'notes.txt',
      '.env',
      '.basic-auth.short',
      '.basic-auth.toolong1',
      '.basic-auth.',
      'basic-auth.caddy.bak',
      'basic-auth.caddy~',
      '..hidden',
      'weird name',
    ];
    for (const name of refused) {
      const s = stg();
      s.write(`staging/${name}`, 'SECRET-CANARY-CONTENT\n', 0o644);
      const r = s.run('scripts/staging/dc.sh', ['up-proxy']);
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(/staging\/ contains an entry that is not allowed/);
      expect(r.stderr, name).not.toContain('SECRET-CANARY-CONTENT');
      expect(s.calls().filter((c) => / up /.test(` ${c}`) && !/config --format/.test(c))).toEqual([]);
    }
    const sub = stg();
    mkdirSync(path.join(sub.root, 'staging/backups'));
    expect(sub.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(/not allowed: backups/);
    const link = stg();
    symlinkSync('/etc/hostname', path.join(link.root, 'staging/README.md'));
    expect(link.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(/not allowed: README\.md/);
    // the database-only start does not mount the directory and is not blocked by it
    const db = stg();
    db.write('staging/backup.sql', 'x', 0o644);
    expect(db.run('scripts/staging/dc.sh', ['up', '-d', '--wait', 'db']).status).toBe(0);
  }, 120_000);
  it('starts the proxy only with a regular, readable-by-the-proxy, not group/world-writable Basic Auth hash file', () => {
    const missing = stg();
    missing.write('staging/basic-auth.caddy', 'x');
    spawnSync('rm', ['-f', path.join(missing.root, 'staging/basic-auth.caddy')]);
    expect(missing.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(
      /missing or not a regular file/,
    );
    // decision 228: 0644 is the CORRECT mode (the proxy's root has no DAC_OVERRIDE); 0600 is what crash-looped the first real VPS
    const hashPath = (s: { root: string }) => path.join(s.root, 'staging/basic-auth.caddy');
    for (const bad of [0o600, 0o640, 0o664, 0o666, 0o646, 0o444 | 0o020]) {
      const s = stg();
      chmodSync(hashPath(s), bad);
      const r = s.run('scripts/staging/dc.sh', ['up-proxy']);
      expect(r.status, bad.toString(8)).toBe(1);
      expect(r.stderr, bad.toString(8)).toMatch(/must be mode 0644/);
      expect(s.called(), bad.toString(8)).not.toMatch(/up -d --wait proxy/);
    }
    for (const ok of [0o644, 0o444]) {
      const s = stg();
      chmodSync(hashPath(s), ok);
      expect(s.run('scripts/staging/dc.sh', ['up-proxy']).status, ok.toString(8)).toBe(0);
    }
    // a wrong owner, the two branches INDEPENDENTLY. A stub `stat` reports another uid for exactly one path; everything else is the real stat.
    const statStub = (root: string, path1: string) =>
      writeFileSync(
        path.join(root, 'bin/stat'),
        `#!/bin/sh\ncase "$*" in *%u*"${path1}") echo 424242; exit 0;; esac\nexec /usr/bin/stat "$@"\n`,
        { mode: 0o755 },
      );
    const fileOwner = stg();
    statStub(fileOwner.root, 'staging/basic-auth.caddy');
    const fo = fileOwner.run('scripts/staging/dc.sh', ['up-proxy']);
    expect(fo.status).toBe(1);
    expect(fo.stderr).toMatch(/basic-auth\.caddy does not belong to the current user/); // the directory check had passed
    expect(fo.stderr).not.toMatch(/staging\/ must belong/);
    const dirOwner = stg();
    statStub(dirOwner.root, 'staging');
    const dow = dirOwner.run('scripts/staging/dc.sh', ['up-proxy']);
    expect(dow.status).toBe(1);
    expect(dow.stderr).toMatch(/staging\/ must belong to the current user/);
    expect(fileOwner.calls().filter((c) => / up /.test(` ${c}`) && !/config --format/.test(c))).toEqual([]);
    const dirWide = stg();
    chmodSync(path.join(dirWide.root, 'staging'), 0o775);
    expect(dirWide.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(/staging\/ must belong/);
    const dirClosed = stg();
    chmodSync(path.join(dirClosed.root, 'staging'), 0o750);
    expect(dirClosed.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(/traversable by others/);
    const asDir = stg();
    spawnSync('rm', ['-f', hashPath(asDir)]);
    mkdirSync(hashPath(asDir));
    expect(asDir.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(
      /not a regular file|not allowed: basic-auth\.caddy/,
    );
    const link = stg();
    spawnSync('rm', ['-f', hashPath(link)]);
    symlinkSync('/etc/hostname', hashPath(link));
    expect(link.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(
      /not a regular file|not allowed: basic-auth\.caddy/,
    );
    const stagingLink = stg();
    spawnSync('mv', [path.join(stagingLink.root, 'staging'), path.join(stagingLink.root, 'staging.real')]);
    symlinkSync('staging.real', path.join(stagingLink.root, 'staging'));
    expect(stagingLink.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(
      /staging\/ is missing, a link/,
    );
    const junk = stg();
    junk.write('staging/basic-auth.caddy', 'hello\n', 0o644);
    expect(junk.run('scripts/staging/dc.sh', ['up-proxy']).stderr).toMatch(/does not look like/);
    expect(stg().run('scripts/staging/dc.sh', ['up-proxy']).status).toBe(0);
    // the database alone may start without the file (the first start order); a bare `up` may not
    expect(missing.run('scripts/staging/dc.sh', ['up', '-d', '--wait', 'db']).status).toBe(0);
    expect(missing.run('scripts/staging/dc.sh', ['up', '-d']).status).toBe(1);
  }, 120_000);
});
