import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, loadMaintenanceEnv } from '../src/lib/env';
import { CHECKLIST } from '../src/modules/platform-security/domain/checklist';

// C2 (CODEX-REVIEW-R9): the production files are read as text so that a regression of a hardening item fails here.
const compose = readFileSync('docker-compose.prod.yml', 'utf8');
const runbook = readFileSync('docs/RUNBOOK.md', 'utf8');
const block = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z_]+:\n|\n[a-z]+:/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe('secrets are separated (item 3)', () => {
  const valid = {
    DATABASE_URL_APP: 'postgres://app:pw@db:5432/belgobeton',
    DATABASE_URL_AUTH: 'postgres://auth:pw@db:5432/belgobeton',
    DATABASE_URL_SYSTEM: 'postgres://system:pw@db:5432/belgobeton',
    AUTH_SECRET: 'a'.repeat(32),
    FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    RECOVERY_CODES_KEYS: `r1:${Buffer.alloc(32, 8).toString('base64')}`,
    LOOKUP_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
    APP_BASE_URL: 'https://app.example.test',
    BACKUP_AGE_RECIPIENT: 'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq',
  };
  it('the app starts without the migrator login, and the maintenance scripts demand it', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', REAL_DATA: 'true' })).not.toThrow();
    expect(() => loadMaintenanceEnv(valid)).toThrow(/DATABASE_URL_MIGRATOR/);
    expect(
      loadMaintenanceEnv({ ...valid, DATABASE_URL_MIGRATOR: 'postgres://migrator:pw@db:5432/belgobeton' })
        .DATABASE_URL_MIGRATOR,
    ).toContain('migrator');
  });
  it('each service reads only its own secret file', () => {
    expect(block('app')).toMatch(/env_file: \.env\.prod\n/);
    expect(block('backup')).toMatch(/env_file: \[\.env\.backup\.prod\]/);
    expect(block('ops')).toMatch(/env_file: \[\.env\.prod, \.env\.ops\.prod\]/);
    const envFiles = (name: string) => block(name).match(/env_file:.*$/m)?.[0] ?? '';
    expect(envFiles('app')).not.toMatch(/ops\.prod|backup\.prod/);
    expect(envFiles('backup')).not.toMatch(/\.env\.prod\b|ops\.prod/);
  });
  it('the runbook puts the migrator and backup logins out of .env.prod', () => {
    expect(runbook).toMatch(/`\.env\.ops\.prod`[^\n]*DATABASE_URL_MIGRATOR/);
    expect(runbook).toMatch(/`\.env\.backup\.prod`[^\n]*DATABASE_URL_BACKUP/);
  });
});

describe('every compose and cron command loads its env file (item 4)', () => {
  it('goes through scripts/ops/dc.sh, which passes --env-file', () => {
    const dc = readFileSync('scripts/ops/dc.sh', 'utf8');
    expect(dc).toMatch(/docker compose -f docker-compose\.prod\.yml --env-file \.env\.ops\.prod "\$@"/);
    const offenders: string[] = [];
    const files = ['docs/RUNBOOK.md', ...readdirSync('scripts/ops').map((f) => `scripts/ops/${f}`)].filter(
      (f) => f !== 'scripts/ops/dc.sh',
    );
    for (const f of files)
      for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries())
        if (
          /docker compose/.test(line) &&
          !/^\s*#/.test(line) &&
          !/dc\.sh/.test(line) &&
          !/^>? ?(docker compose|`docker compose`)/.test('')
        )
          offenders.push(`${f}:${i + 1} ${line.trim()}`);
    // prose lines that merely name the command are allowed only when they also say dc.sh or are explanatory comments
    expect(offenders.filter((o) => !/bare|plain|never|not /.test(o))).toEqual([]);
  });
  it('compose requires the variables instead of defaulting them', () => {
    expect(compose).toMatch(/APP_DOMAIN: \$\{APP_DOMAIN:\?/);
    expect(compose).toMatch(/\$\{APP_IMAGE:\?/);
    expect(compose).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_SUPERUSER_PASSWORD:\?/);
  });
});

describe('HTTPS for the public domain (item 6)', () => {
  it('passes APP_DOMAIN to Caddy and does not fall back to localhost', () => {
    expect(block('proxy')).toMatch(/APP_DOMAIN: \$\{APP_DOMAIN:\?/);
    const caddy = readFileSync('Caddyfile', 'utf8');
    expect(caddy).toMatch(/^\{\$APP_DOMAIN\} \{$/m);
    expect(caddy).not.toMatch(/:localhost\}/);
  });
});

describe('the image and the host (items 10, 12)', () => {
  const docker = readFileSync('Dockerfile', 'utf8');
  const runtime = docker.slice(docker.indexOf('AS runtime'));
  it('has no pnpm or corepack in the runtime stage and runs the scripts with plain node', () => {
    expect(runtime.replace(/^#.*$/gm, '')).not.toMatch(/corepack|pnpm/);
    expect(readFileSync('scripts/ops/ops.sh', 'utf8')).toMatch(
      /node --import \.\/scripts\/register-ts-paths\.mjs/,
    );
    expect(runbook).not.toMatch(/ops corepack pnpm/);
    expect(runbook).not.toMatch(/run --rm ops corepack/);
  });
  it('fixes the uid and creates the data directories owned by it', () => {
    expect(runtime).toMatch(/-g 10001/);
    expect(runtime).toMatch(/-u 10001/);
    expect(runtime).toMatch(/chown -R 10001:10001 \/data/);
    expect(readFileSync('scripts/ops/init-host.sh', 'utf8')).toMatch(
      /install -d -o 10001 -g belgobeton-backup -m 2750/,
    );
  });
  it('keeps the Excel imports out of git and out of the image', () => {
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^imports\/$/m);
    expect(readFileSync('.dockerignore', 'utf8')).toMatch(/^imports$/m);
  });
  it('the container health check is readiness, which counts the migrations', () => {
    expect(runtime).toMatch(/HEALTHCHECK[\s\S]*\/api\/health\/ready/);
  });
});

describe('hosting in Switzerland (item 7)', () => {
  it('the checklist asks for the CNDP transfer declaration, not for Moroccan hosting', () => {
    expect(Object.keys(CHECKLIST)).toContain('cndp_transfer_declared');
    expect(Object.keys(CHECKLIST)).not.toContain('moroccan_hosting');
    expect(Object.keys(CHECKLIST)).toContain('field_keys_escrowed_off_host');
    const req = readFileSync('docs/REQUIREMENTS-V1.md', 'utf8');
    expect(req).toMatch(/Infomaniak, Switzerland/);
    expect(req).not.toMatch(/VPS in a data centre in Morocco/);
    expect(runbook).toMatch(/Infomaniak/);
    expect(runbook).not.toMatch(/in a Moroccan data centre/);
  });
});

describe('deploy by digest from the private registry (GitHub Actions)', () => {
  const wf = 'github/workflows/build-image.yml'.replace(/^/, '.');
  it('builds linux/amd64, pushes to ghcr.io and reports the digest', () => {
    expect(existsSync(wf)).toBe(true);
    const y = readFileSync(wf, 'utf8');
    expect(y).toMatch(/platforms: linux\/amd64/);
    expect(y).toMatch(/registry: ghcr\.io/);
    expect(y).toMatch(/packages: write/);
    expect(y).toMatch(/steps\.build\.outputs\.digest/);
    expect(y).not.toMatch(/\bghp_[A-Za-z0-9]/);
  });
  it('the server deploys by digest only, with a rollback', () => {
    const d = readFileSync('scripts/ops/deploy.sh', 'utf8');
    expect(d).toMatch(/@sha256:/);
    expect(d).toMatch(/rolled back/);
    expect(d).toMatch(/backup-nightly\.sh/);
  });
});

describe('bootstrap and host ownership (F04 of the final review)', () => {
  it('the bootstrap service is the only one that reads the temporary bootstrap file, and it is not in the default profile', () => {
    expect(block('bootstrap')).toMatch(/env_file: \[\.env\.prod, \.env\.ops\.prod, \.env\.bootstrap\.prod\]/);
    expect(block('bootstrap')).toMatch(/profiles: \[bootstrap\]/);
    for (const name of ['app', 'ops', 'backup'])
      expect(block(name).match(/env_file:.*$/m)?.[0] ?? '', name).not.toMatch(/bootstrap/);
  });
  it('the documented first install uses the bootstrap wrapper and never gives the backup login to the app or ops files', () => {
    expect(runbook).toMatch(/\.\/scripts\/ops\/bootstrap\.sh/);
    expect(runbook).not.toMatch(/ops\.sh db-bootstrap/);
    expect(runbook).toMatch(/`\.env\.bootstrap\.prod`[^\n]*temporary/i);
  });
  it('init-host gives keys/ and reports/ to the deploy account and group 10001, and verify-host checks it', () => {
    const init = readFileSync('scripts/ops/init-host.sh', 'utf8');
    expect(init).toMatch(/install -d -o "\$deployer" -g 10001 -m 2750 "\$root\/keys" "\$root\/reports"/);
    expect(init).not.toMatch(/install -d -m 0750 "\$root\/reports"/);
    const verify = readFileSync('scripts/ops/verify-host.sh', 'utf8');
    expect(verify).toMatch(/10001 2750/);
    expect(verify).toMatch(/permitrootlogin no'/);
  });
  it('production bootstrap creates its own database only, not the scratch test database', () => {
    const script = readFileSync('scripts/db-bootstrap.ts', 'utf8');
    expect(script).toMatch(/if \(process\.env\.NODE_ENV !== 'production'\) databases\.push\(TEST_DATABASE\)/);
  });
});

describe('scripts/ops/bootstrap.sh (F04)', () => {
  const run = (content: string | null, dcExit: number) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-boot-'));
    mkdirSync(path.join(dir, 'scripts/ops'), { recursive: true });
    copyFileSync('scripts/ops/bootstrap.sh', path.join(dir, 'scripts/ops/bootstrap.sh'));
    writeFileSync(
      path.join(dir, 'dc-stub.sh'),
      `#!/usr/bin/env bash\necho "$@" >> "${dir}/dc.log"\nexit ${dcExit}\n`,
      { mode: 0o755 },
    );
    if (content !== null) writeFileSync(path.join(dir, '.env.bootstrap.prod'), content);
    const r = spawnSync('bash', [path.join(dir, 'scripts/ops/bootstrap.sh')], {
      env: { ...process.env, DC: path.join(dir, 'dc-stub.sh') },
      encoding: 'utf8',
    });
    return {
      dir,
      status: r.status,
      err: r.stderr,
      left: existsSync(path.join(dir, '.env.bootstrap.prod')),
      called: existsSync(path.join(dir, 'dc.log')),
    };
  };
  it('runs the bootstrap service once and deletes the file when it succeeds', () => {
    const r = run('DATABASE_URL_BACKUP=postgres://b:pw@db:5432/x\n', 0);
    expect(r.status).toBe(0);
    expect(r.called).toBe(true);
    expect(r.left).toBe(false);
  });
  it('keeps the file when the run fails (so it can be retried) and says so by its exit code', () => {
    const r = run('DATABASE_URL_BACKUP=postgres://b:pw@db:5432/x\n', 3);
    expect(r.status).not.toBe(0);
    expect(r.left).toBe(true);
  });
  it('refuses a file with any other variable, an empty file and a missing file, and runs nothing', () => {
    for (const content of [
      'DATABASE_URL_BACKUP=postgres://b@db/x\nAUTH_SECRET=oops\n',
      '# nothing\n',
      null,
    ]) {
      const r = run(content, 0);
      expect(r.status, String(content)).not.toBe(0);
      expect(r.called, String(content)).toBe(false);
    }
  });
});

describe('scripts/ops/deploy.sh (F05 of the final review)', () => {
  const OLD = `ghcr.io/o/belgobeton@sha256:${'a'.repeat(64)}`;
  const NEW = `ghcr.io/o/belgobeton@sha256:${'b'.repeat(64)}`;
  /** Runs deploy.sh from a directory that is NOT the repository root, against stubs; `fail` names the step that fails. */
  const deploy = (
    fail: 'none' | 'pull' | 'backup' | 'migrate' | 'up' | 'ready',
    previous: string | null = OLD,
  ) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-deploy-'));
    mkdirSync(path.join(dir, 'scripts/ops'), { recursive: true });
    copyFileSync('scripts/ops/deploy.sh', path.join(dir, 'scripts/ops/deploy.sh'));
    writeFileSync(
      path.join(dir, '.env.ops.prod'),
      `APP_DOMAIN=x.test\n${previous ? `APP_IMAGE=${previous}\n` : ''}FIRST_BOOT=\n`,
    );
    const log = path.join(dir, 'calls.log');
    const stub = (name: string, body: string) =>
      writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub('docker', `echo "docker $*" >> "${log}"; [ "${fail}" = pull ] && exit 5; exit 0`);
    stub('backup', `echo "backup" >> "${log}"; [ "${fail}" = backup ] && exit 6; exit 0`);
    stub('ops', `echo "ops $*" >> "${log}"; [ "${fail}" = migrate ] && exit 7; exit 0`);
    stub(
      'dc',
      `echo "dc $*" >> "${log}"
case "$1" in
  up) if [ "${fail}" = up ] && [ ! -f "${dir}/rolled" ] && grep -q "${'b'.repeat(64)}" "${dir}/.env.ops.prod"; then exit 8; fi;;
  exec) if [ "${fail}" = ready ]; then exit 1; fi; echo '{"status":"ready"}';;
esac
exit 0`,
    );
    const r = spawnSync('bash', [path.join(dir, 'scripts/ops/deploy.sh'), NEW], {
      cwd: tmpdir(), // not the repository: the script must find its own root
      env: {
        ...process.env,
        DOCKER: path.join(dir, 'docker'),
        DC: path.join(dir, 'dc'),
        OPS: path.join(dir, 'ops'),
        BACKUP: path.join(dir, 'backup'),
        READY_TRIES: '2',
        READY_SLEEP: '0',
      },
      encoding: 'utf8',
    });
    const env = readFileSync(path.join(dir, '.env.ops.prod'), 'utf8');
    return {
      status: r.status,
      err: r.stderr,
      image: /^APP_IMAGE=(.*)$/m.exec(env)?.[1] ?? null,
      calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    };
  };

  it('works from any directory and ends on the new digest after a clean run', () => {
    const r = deploy('none');
    expect(r.status, r.err).toBe(0);
    expect(r.image).toBe(NEW);
    expect(r.calls).toEqual(expect.arrayContaining(['backup', expect.stringContaining('db-migrate')]));
  });
  it('a failure before the switch changes nothing and rolls nothing back (pull, backup)', () => {
    for (const fail of ['pull', 'backup'] as const) {
      const r = deploy(fail);
      expect(r.status, fail).not.toBe(0);
      expect(r.image, fail).toBe(OLD);
      expect(
        r.calls.filter((c) => c.startsWith('dc up')),
        fail,
      ).toEqual([]);
    }
  });
  it('every failure after the switch puts the previous image back and starts it: migration, start, readiness', () => {
    for (const fail of ['migrate', 'up', 'ready'] as const) {
      const r = deploy(fail);
      expect(r.status, fail).not.toBe(0);
      expect(r.image, fail).toBe(OLD);
      expect(r.err, fail).toMatch(/rolled back to/);
      // the last thing run is the start of the previous image
      expect(r.calls[r.calls.length - 1], fail).toBe('dc up -d app');
    }
  });
  it('with no previous image it fails loudly and does not invent one', () => {
    const r = deploy('migrate', null);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/no previous image/);
  });
});
