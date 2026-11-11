import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, loadMaintenanceEnv } from '../src/lib/env';

// T1: the training stack is read as text, so that a regression of one of its rules fails here.
const compose = readFileSync('docker-compose.training.yml', 'utf8');
const block = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z_]+:\n|\n[a-z]+:/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const initEnv = readFileSync('scripts/training/init-env.sh', 'utf8');

describe('the training stack (T1)', () => {
  it('T8-C: the db, app and ops services are pinned to linux/amd64, so Apple Silicon needs no DOCKER_DEFAULT_PLATFORM', () => {
    for (const service of ['db', 'app', 'ops'])
      expect(block(service), service).toMatch(/\n    platform: linux\/amd64\n/);
    expect(compose).not.toMatch(/platform: linux\/arm64/);
  });
  it('runs the app as a training instance on fictitious data, never as production or real data', () => {
    const app = block('app');
    expect(app).toMatch(/TRAINING_MODE: 'true'/);
    expect(app).toMatch(/APP_ENV: training/);
    expect(app).toMatch(/REAL_DATA: 'false'/);
    expect(app).not.toMatch(/APP_ENV: production|REAL_DATA: 'true'/);
  });
  it('R11-02: nothing in the training stack can switch off the marker requirement', () => {
    // the app block forces the escapes off (a runtime test in src/lib/training.test.ts proves the schema refuses them anyway)
    expect(block('app')).toMatch(/TRAINING_ALLOW_UNMARKED: 'false'/);
    expect(block('app')).toMatch(/E2E_TEST_RUNNER: ''/);
    expect(compose).not.toMatch(/TRAINING_ALLOW_UNMARKED: 'true'/);
    expect(initEnv).not.toMatch(/TRAINING_ALLOW_UNMARKED/);
  });
  it('R11-04: the credentials file lives in a Docker volume made private to the container user, not in a shared host folder', () => {
    expect(block('ops')).toMatch(/- accounts:\/app\/out/);
    expect(compose).not.toMatch(/\.\/out:/);
    expect(compose).toMatch(/\n {2}accounts: \{\}/);
    // R18-11: the root job that makes the folder is now run by ops.sh (--prepare-out), so that it leaves execution evidence like every ops job
    const up = readFileSync('scripts/training-up.sh', 'utf8');
    const ops = readFileSync('scripts/training/ops.sh', 'utf8');
    expect(up + ops).not.toMatch(/1777|chmod [0-7]*7 out/);
    expect(up).toMatch(/\$ops --prepare-out/);
    expect(ops).toMatch(/chown 10001:10001 \/app\/out && chmod 700 \/app\/out/);
  });
  it('R11-07: generates no push keys', () => {
    expect(initEnv).not.toMatch(/VAPID/);
    expect(compose).not.toMatch(/VAPID/);
  });
  it('keeps the database off the host, publishes the app on the loopback only, and keeps Caddy for a VPS behind a profile', () => {
    expect(block('db')).not.toMatch(/ports:/);
    expect(block('db')).toMatch(/networks: \[internal\]/);
    expect(block('app')).toMatch(/- '127\.0\.0\.1:\$\{APP_PORT:-3000\}:3000'/);
    expect(block('app')).not.toMatch(/- '(0\.0\.0\.0:)?\d+:3000'/);
    expect(block('proxy')).toMatch(/profiles: \[public\]/);
    expect(block('ops')).not.toMatch(/ports:/);
  });
  it('is the same file for the iMac and for a VPS: no host name, no domain and no path of the iMac in it', () => {
    expect(compose).not.toMatch(/aliobsil|\/Users\/|\.ts\.net/i);
    expect(compose).toMatch(/APP_DOMAIN: \$\{APP_DOMAIN:-\}/);
  });
  it('gives the app no maintenance login: only the ops container reads the second secret file', () => {
    expect(block('app')).toMatch(/env_file: \.env\.training\n/);
    expect(block('ops')).toMatch(/env_file: \[\.env\.training, \.env\.training\.ops\]/);
    expect(initEnv).toMatch(/DATABASE_URL_MIGRATOR[\s\S]*> \.env\.training\.ops/);
    const appPart = initEnv.slice(0, initEnv.indexOf('} > .env.training\n') + 1);
    expect(appPart).not.toMatch(/MIGRATOR|SUPERUSER|DATABASE_URL_BACKUP|DATABASE_URL_SEED/);
  });
  it('generates the secrets with openssl, writes them to the two files only, and never overwrites', () => {
    expect(initEnv).toMatch(/openssl rand/);
    expect(initEnv).toMatch(/already exists.*not overwritten/);
    expect(initEnv).toMatch(/chmod 600 \.env\.training \.env\.training\.ops/);
  });
  it('turns on every module flag that exists, and has no flag for the portals', () => {
    for (const flag of [
      'FIELD_APP_ENABLED',
      'NOTIFICATIONS_ENABLED',
      'CANCELLATIONS_ENABLED',
      'DOCUMENTS_V1_ENABLED',
      'DARIJA_ENABLED',
      'ASSISTANT_DET_ENABLED',
      'TRANSFERS_ENABLED',
      'FINANCE_ENABLED',
    ])
      expect(initEnv).toContain(`${flag}=true`);
    expect(initEnv).not.toMatch(/^[A-Z_]*PORTAL[A-Z_]*=/m);
    expect(initEnv).not.toMatch(/ASSISTANT_PROVIDER=anthropic|ANTHROPIC_API_KEY=|AI_EXTRACTION_ENABLED=true/);
  });
  it('every flag the training env file sets is a real flag of the environment schema', () => {
    const env = readFileSync('src/lib/env.ts', 'utf8');
    for (const m of initEnv.matchAll(/^([A-Z_]+_ENABLED)=true$/gm))
      expect(env, m[1]).toContain(`${m[1]}: flag`);
  });
});

describe('init-env.sh really produces a working training environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-trainenv-'));
  mkdirSync(path.join(dir, 'scripts/training'), { recursive: true });
  copyFileSync('scripts/training/init-env.sh', path.join(dir, 'scripts/training/init-env.sh'));
  copyFileSync('scripts/training/image-policy.sh', path.join(dir, 'scripts/training/image-policy.sh'));
  const run = () =>
    spawnSync('bash', [path.join(dir, 'scripts/training/init-env.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_BASE_URL: 'http://localhost:3000',
        APP_IMAGE: `ghcr.io/aliescoobs-sudo/kayas@sha256:${'a'.repeat(64)}`,
      },
    });
  const parse = (file: string) =>
    Object.fromEntries(
      readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  it('writes two files of mode 600 whose values the environment check accepts as a training instance', () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(path.join(dir, '.env.training')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, '.env.training.ops')).mode & 0o777).toBe(0o600);
    const app = parse('.env.training');
    const ops = parse('.env.training.ops');
    const training = {
      ...app,
      TRAINING_MODE: 'true',
      APP_ENV: 'training',
      NODE_ENV: 'production',
      REAL_DATA: 'false',
    };
    expect(loadEnv(training).TRAINING_MODE).toBe(true);
    expect(loadEnv(training).FINANCE_ENABLED).toBe(true);
    expect(() => loadMaintenanceEnv({ ...training, ...ops })).not.toThrow();
    expect(app.APP_BASE_URL).toBe('http://localhost:3000');
    // the app can start without any maintenance login
    expect('DATABASE_URL_MIGRATOR' in app).toBe(false);
    // the secrets do not appear in what the script says
    for (const v of [app.AUTH_SECRET!, ops.POSTGRES_SUPERUSER_PASSWORD!])
      expect(r.stdout + r.stderr).not.toContain(v);
  });
  it('refuses to overwrite the files it wrote', () => {
    const r = run();
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(dir, '.env.training'))).toBe(true);
  });
});

/** A throwaway copy of the scripts with a stub compose wrapper, so that the host scripts run without Docker. */
function sandbox(dcBody: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-trainsh-'));
  mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
  for (const f of ['scripts/training-backup.sh']) copyFileSync(f, path.join(root, f));
  writeFileSync(path.join(root, 'scripts/training/dc.sh'), `#!/usr/bin/env bash\n${dcBody}\n`);
  for (const f of ['scripts/training-backup.sh', 'scripts/training/dc.sh'])
    chmodSync(path.join(root, f), 0o755);
  return root;
}
const withStub = (dir: string, name: string, body: string) => {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return path.join(dir, 'bin');
};

describe('scripts/training-backup.sh (T1)', () => {
  const backup = (dest: (root: string) => string, dump = 'PGDMP-fake') => {
    const root = sandbox(`printf '%s' '${dump}'`);
    const to = dest(root);
    const r = spawnSync('bash', [path.join(root, 'scripts/training-backup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, TRAINING_BACKUP_DIR: to },
    });
    return { r, to };
  };
  it('writes a private dump outside the repository and refuses a folder inside it', () => {
    const { r, to } = backup(() => path.join(mkdtempSync(path.join(tmpdir(), 'bb-bk-')), 'dumps'));
    expect(r.status, r.stderr).toBe(0);
    const files = readdirSync(to).filter((f) => f.endsWith('.dump'));
    expect(files).toHaveLength(1);
    expect(statSync(path.join(to, files[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(to).mode & 0o777).toBe(0o700);
    const inside = backup((root) => path.join(root, 'backups'));
    expect(inside.r.status).toBe(2);
    expect(inside.r.stderr).toMatch(/outside the repository/);
  });
  it('refuses an empty dump and keeps no partial file', () => {
    const { r, to } = backup(() => path.join(mkdtempSync(path.join(tmpdir(), 'bb-bk-')), 'dumps'), '');
    expect(r.status).not.toBe(0);
    expect(readdirSync(to)).toEqual([]);
  });
});

describe('scripts/training/set-url.sh (R11-03)', () => {
  const run = (hostile: 'none' | 'stale-temp' | 'symlink', url = 'http://localhost:3000') => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-seturl-'));
    mkdirSync(path.join(dir, 'scripts/training'), { recursive: true });
    copyFileSync('scripts/training/set-url.sh', path.join(dir, 'scripts/training/set-url.sh'));
    writeFileSync(
      path.join(dir, 'scripts/training/dc.sh'),
      '#!/usr/bin/env bash\necho "dc $*" >> "$(dirname "$0")/../../calls.log"\n',
      {
        mode: 0o755,
      },
    );
    writeFileSync(
      path.join(dir, '.env.training'),
      'AUTH_SECRET=s3cret\nAPP_BASE_URL=http://127.0.0.1:3000\n',
      {
        mode: 0o600,
      },
    );
    if (hostile === 'stale-temp')
      writeFileSync(path.join(dir, '.env.training.new'), 'planted\n', { mode: 0o666 });
    if (hostile === 'symlink') {
      renameSync(path.join(dir, '.env.training'), path.join(dir, 'real.env'));
      symlinkSync('real.env', path.join(dir, '.env.training'));
    }
    // umask 022 on purpose: the script must not depend on the caller's umask
    const r = spawnSync(
      'bash',
      ['-c', 'umask 022; exec bash "$0" "$@"', path.join(dir, 'scripts/training/set-url.sh'), url],
      {
        encoding: 'utf8',
      },
    );
    const real = path.join(dir, hostile === 'symlink' ? 'real.env' : '.env.training');
    return {
      dir,
      status: r.status,
      err: r.stderr,
      text: readFileSync(real, 'utf8'),
      mode: statSync(real).mode & 0o777,
      leftovers: readdirSync(dir).filter((f) => f.startsWith('.env.training.')),
    };
  };
  it('replaces the address and keeps the file private, with no temporary file left', () => {
    const r = run('none');
    expect(r.status, r.err).toBe(0);
    expect(r.text).toContain('AUTH_SECRET=s3cret');
    expect(r.text).toContain('APP_BASE_URL=http://localhost:3000');
    expect(r.text.match(/APP_BASE_URL=/g)).toHaveLength(1);
    expect(r.mode.toString(8)).toBe('600');
    expect(r.leftovers).toEqual([]);
  });
  it('accepts local addresses only: a public or tunnel address is refused and nothing is written (R15A-06)', () => {
    for (const url of ['https://imac.tail1.ts.net', 'https://beton.example.test', 'http://evil.example']) {
      const r = run('none', url);
      expect(r.status, url).toBe(2);
      expect(r.err).toMatch(/local address/);
      expect(r.text).toContain('APP_BASE_URL=http://127.0.0.1:3000');
    }
  });
  it('never reuses a planted temporary name, and refuses a symbolic link', () => {
    const planted = run('stale-temp');
    expect(planted.status, planted.err).toBe(0);
    expect(planted.mode.toString(8)).toBe('600');
    expect(readFileSync(path.join(planted.dir, '.env.training.new'), 'utf8')).toBe('planted\n');
    const linked = run('symlink');
    expect(linked.status).not.toBe(0);
    expect(linked.err).toMatch(/symbolic link/);
    expect(linked.text).not.toContain('localhost');
  });
  it('the script creates nothing with a shell redirection before it is private', () => {
    const text = readFileSync('scripts/training/set-url.sh', 'utf8');
    expect(text).toMatch(/^umask 077$/m);
    expect(text).toMatch(/mktemp/);
    expect(text).not.toMatch(/> \.env\.training\.new/);
  });
});

describe('the iMac guides protect the host credentials (R11-10)', () => {
  const en = readFileSync('docs/checkpoints/CP-TRAINING.md', 'utf8');
  const fr = readFileSync('docs/checkpoints/CP-TRAINING-IMAC-FR.md', 'utf8');
  it('keep FileVault on and never suggest automatic login', () => {
    expect(en).toMatch(/Keep FileVault ON and automatic login OFF/);
    expect(en).not.toMatch(/Turn off FileVault|turn on automatic login/i);
    expect(fr).toMatch(/FileVault : activé/);
    expect(fr).toMatch(/Connexion automatique : désactivée/);
    expect(fr).not.toMatch(/désactive(r)? FileVault|(?<!PAS )activer la connexion automatique/i);
  });
  it('require the macOS Keychain as Docker credential helper, checked before and after the login, with a read-only token', () => {
    for (const doc of [en, fr]) {
      expect(doc).toMatch(/osxkeychain/);
      expect(doc).toMatch(/docker-credential-helper/);
      expect(doc).toMatch(/grep -c '"auth"'/);
      expect(doc).toMatch(/read:packages/);
    }
    expect(en.indexOf('osxkeychain')).toBeLessThan(en.indexOf('docker login ghcr.io'));
    expect(fr.indexOf('osxkeychain')).toBeLessThan(fr.indexOf('docker login ghcr.io'));
  });
  it('hand out one trainee line at a time and keep no transcript', () => {
    for (const doc of [en, fr]) {
      expect(doc).toMatch(/show-accounts\.sh <?[a-zé ]+/i);
      expect(doc).toMatch(/script/);
    }
    expect(en).toMatch(/Never circulate the whole list/);
    expect(fr).toMatch(/jamais la liste entière/);
  });
});

describe('the guides state the local-only policy and the phone operating rule (R11, R15A-06)', () => {
  const en = readFileSync('docs/checkpoints/CP-TRAINING.md', 'utf8');
  const fr = readFileSync('docs/checkpoints/CP-TRAINING-IMAC-FR.md', 'utf8');
  it('tie the image to the exact commit, never "the latest green run"', () => {
    for (const doc of [en, fr]) {
      expect(doc).toMatch(/pick-image\.sh/);
      expect(doc).not.toMatch(/latest green (run|passage)|dernier passage vert/i);
    }
    expect(en).toMatch(/exact commit/);
    expect(fr).toMatch(/commit exact/);
  });
  it('say local only, nothing public, no tunnel, and that the operator is responsible for no publisher', () => {
    expect(en).toMatch(/LOCAL ONLY/);
    expect(en).toMatch(/http:\/\/localhost:3000/);
    expect(en).toMatch(/operator is responsible/i);
    expect(fr).toMatch(/UNIQUEMENT EN LOCAL/);
    expect(fr).toMatch(/http:\/\/localhost:3000/);
    expect(fr).toMatch(/responsabilité de l'opérateur|opérateur est responsable/i);
  });
  it('contain no instruction that publishes the instance', () => {
    for (const doc of [en, fr]) {
      expect(doc).not.toMatch(
        /go-public\.sh https|tailscale funnel --bg|tailscale up|brew services start tailscale/,
      );
      expect(doc).not.toMatch(/^\s*[a-e]\.\s+.*Funnel/m);
    }
  });
  it('give the phone operating rule: one browser profile per identity, no logout/login handover, stop on a stuck session', () => {
    expect(en).toMatch(/SEPARATE BROWSER PROFILE/);
    expect(en).toMatch(/never hand a phone over by signing\s+out and signing in again in the same live page/);
    expect(en).toMatch(/STOP that profile's exercise/);
    expect(fr).toMatch(/PROFIL DE NAVIGATEUR SÉPARÉ/);
    expect(fr).toMatch(/jamais passer un téléphone/i);
    expect(fr).toMatch(/ARRÊTE l'exercice de ce profil/);
  });
});

describe('the training guides do not promise what was not rehearsed (R11-09, R11-10)', () => {
  const guide = readFileSync('docs/checkpoints/CP-TRAINING.md', 'utf8');
  it('R11-09: a move to a VPS starts with a fresh seed; a dump alone is not a transfer', () => {
    expect(guide).toMatch(/starts with a fresh training seed/);
    expect(guide).toMatch(/discarded/);
    expect(guide).not.toMatch(/Copy the data over/);
    expect(guide).toMatch(/database only/);
  });
});

describe('scripts/training/show-accounts.sh (R11-10)', () => {
  const FILE = [
    'KAYAS — comptes de formation',
    'Adresse : http://127.0.0.1:3000',
    '',
    'Ce fichier est lu une seule fois.',
    '',
    'Propriétaire (owner)',
    '  e-mail : proprietaire@formation.kayas.invalid',
    '  mot de passe : PWD-OWNER-AAAA',
    '',
    'Chauffeur 1 (driver)',
    '  code   : CH-01',
    '  PIN : 111222',
    '',
    'Chauffeur 2 (driver)',
    '  code   : CH-02',
    '  PIN : 333444',
    '',
  ].join('\n');
  const run = (...args: string[]) => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-show-'));
    mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
    copyFileSync('scripts/training/show-accounts.sh', path.join(root, 'scripts/training/show-accounts.sh'));
    writeFileSync(path.join(root, 'file.txt'), FILE);
    // the stub stands for `dc.sh run --rm -T ops cat <file>`: it prints the sample
    writeFileSync(
      path.join(root, 'scripts/training/dc.sh'),
      `#!/usr/bin/env bash\ncat "${root}/file.txt"\n`,
      { mode: 0o755 },
    );
    return spawnSync('bash', [path.join(root, 'scripts/training/show-accounts.sh'), ...args], {
      encoding: 'utf8',
    });
  };
  it('with no argument lists the accounts and prints no secret', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Propriétaire (owner)');
    expect(r.stdout).toContain('Chauffeur 2 (driver)');
    expect(r.stdout + r.stderr).not.toMatch(/PWD-OWNER|111222|333444/);
  });
  it('shows only the block asked for', () => {
    const r = run('ch-02');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('333444');
    expect(r.stdout).not.toMatch(/111222|PWD-OWNER/);
    expect(run('proprietaire').stdout).toContain('PWD-OWNER-AAAA');
    expect(run('proprietaire').stdout).not.toContain('333444');
    expect(run('Chauffeur 2').stdout).toContain('333444'); // the whole name is exact too
    expect(run('proprietaire@formation.kayas.invalid').stdout).toContain('PWD-OWNER-AAAA');
  });
  it('R12-06: a generic word, the shared domain or a part of a code prints NO secret and says why', () => {
    for (const generic of [
      'chauffeur',
      'formation.kayas.invalid',
      'beton',
      'driver',
      'ch',
      'CH-0',
      'e-mail',
      'code',
    ]) {
      const r = run(generic);
      expect(r.status, generic).not.toBe(0);
      expect(r.stdout, generic).toBe('');
      expect(r.stdout + r.stderr, generic).not.toMatch(/PWD-OWNER|111222|333444/);
    }
    const ambiguous = run('chauffeur');
    expect(ambiguous.stderr).toMatch(/part of 2 of them/);
    expect(ambiguous.stderr).toContain('Chauffeur 1 (driver)'); // names only, to help choose
  });
  it('R12-06: the secret text is never matched', () => {
    expect(run('111222').status).toBe(1);
    expect(run('PWD-OWNER-AAAA').status).toBe(1);
    expect(run('pin').status).toBe(1);
    expect(run('mot de passe').status).toBe(1);
  });
  it('refuses an unknown name and an unknown option; everything needs --all and says so', () => {
    expect(run('nobody').status).toBe(1);
    expect(run('nobody').stderr).toMatch(/no account/);
    expect(run('--nope').status).toBe(2);
    const all = run('--all');
    expect(all.stdout).toMatch(/PWD-OWNER-AAAA[\s\S]*111222[\s\S]*333444/);
    expect(all.stderr).toMatch(/WARNING/);
  });
});

describe('pick-image.sh and the stub sandbox (R11)', () => {
  const sbx = (files: string[], dcBody: string, env = '') => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-gopub-'));
    mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
    for (const f of files) {
      copyFileSync(`scripts/training/${f}`, path.join(root, 'scripts/training', f));
      chmodSync(path.join(root, 'scripts/training', f), 0o755);
    }
    writeFileSync(path.join(root, 'scripts/training/dc.sh'), `#!/usr/bin/env bash\n${dcBody}\n`, {
      mode: 0o755,
    });
    if (env) writeFileSync(path.join(root, '.env.training'), env, { mode: 0o600 });
    return root;
  };

  describe('pick-image.sh', () => {
    const SHA_LINE = (sha: string) =>
      `IMAGE_REF=ghcr.io/aliescoobs-sudo/kayas@sha256:${'c'.repeat(64)} COMMIT=${sha}`;
    const pick = (runList: string, log: (sha: string) => string) => {
      const root = sbx(['pick-image.sh', 'image-policy.sh'], '');
      const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
      git('init', '-q');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
      const sha = git('rev-parse', 'HEAD').stdout.trim();
      const bin = withStub(
        root,
        'gh',
        `if [ "$1 $2" = "run list" ]; then echo '${runList}'; else printf '%s\\n' "${log(sha)}"; fi`,
      );
      const r = spawnSync('bash', [path.join(root, 'scripts/training/pick-image.sh')], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      return { r, sha };
    };
    it('prints the digest of the green run of this very commit', () => {
      const { r, sha } = pick('777', SHA_LINE);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(`ghcr.io/aliescoobs-sudo/kayas@sha256:${'c'.repeat(64)}`);
      expect(r.stderr).toContain(sha);
    });
    it('refuses when no green run exists for the commit, when the run built another commit, and when the log has no reference', () => {
      expect(pick('', SHA_LINE).r.status).toBe(1);
      const other = pick('777', () => SHA_LINE('f'.repeat(40)));
      expect(other.r.status).toBe(1);
      expect(other.r.stderr).toMatch(/built commit/);
      const none = pick('777', () => 'nothing here');
      expect(none.r.status).toBe(1);
      expect(none.r.stderr).toMatch(/IMAGE_REF/);
    });
  });
});

// R15A-06: the public helpers are retired. Tailscale is dropped; the instance is local only, and the start-up does not vouch for it.
describe('the public helpers are retired (R15A-06)', () => {
  it('go-public.sh, funnel-check.sh and their shared library are gone', () => {
    for (const f of ['go-public.sh', 'funnel-check.sh', 'lib.sh'])
      expect(existsSync(`scripts/training/${f}`), f).toBe(false);
  });
  const up = readFileSync('scripts/training-up.sh', 'utf8');
  const down = readFileSync('scripts/training-down.sh', 'utf8');
  it('no script runs or mentions a tunnel command', () => {
    for (const text of [up, down]) {
      expect(text).not.toMatch(/tailscale|funnel-check|go-public|set-url\.sh https/i);
    }
  });
  it('the start-up message makes no local-only claim from a check: it says the operator is responsible', () => {
    expect(up).toMatch(/operator is responsible/i);
    expect(up).not.toMatch(
      /is running on this machine only|nothing is published, or exactly this app|Funnel check passed/i,
    );
  });
  it('training-up.sh starts the app and prints the local address, with no check of any publisher', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-r15up-'));
    mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
    copyFileSync('scripts/training-up.sh', path.join(root, 'scripts/training-up.sh'));
    copyFileSync('scripts/training/image-policy.sh', path.join(root, 'scripts/training/image-policy.sh'));
    const stub = (name: string, body: string) =>
      writeFileSync(path.join(root, 'scripts/training', name), `#!/usr/bin/env bash\n${body}\n`, {
        mode: 0o755,
      });
    stub(
      'dc.sh',
      `case "$*" in *"exec -T app wget"*) echo '{"status":"ready"}';; config) printf 'name: kayas-training\\nservices:\\n  app:\\n    ports:\\n      - published: "3000"\\n';; esac`,
    );
    stub('ops.sh', 'exit 0');
    writeFileSync(
      path.join(root, '.env.training'),
      `APP_IMAGE=ghcr.io/aliescoobs-sudo/kayas@sha256:${'a'.repeat(64)}\n`,
      {
        mode: 0o600,
      },
    );
    writeFileSync(path.join(root, '.env.training.ops'), 'X=1\n', { mode: 0o600 });
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // a tailscale on the PATH that fails loudly if anything calls it
    writeFileSync(
      path.join(bin, 'tailscale'),
      '#!/usr/bin/env bash\necho CALLED >> "$(dirname "$0")/../tailscale.called"\nexit 1\n',
      {
        mode: 0o755,
      },
    );
    const r = spawnSync('bash', [path.join(root, 'scripts/training-up.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, READY_TRIES: '1', READY_SLEEP: '0' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/http:\/\/localhost:3000|127\.0\.0\.1:3000/);
    expect(r.stdout).toMatch(/operator is responsible/i);
    expect(existsSync(path.join(root, 'tailscale.called'))).toBe(false);
  });
});

describe('init-env.sh creates its files exclusively, never through a link (R12)', () => {
  const setup = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-initenv-'));
    mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
    copyFileSync('scripts/training/init-env.sh', path.join(root, 'scripts/training/init-env.sh'));
    copyFileSync('scripts/training/image-policy.sh', path.join(root, 'scripts/training/image-policy.sh'));
    return root;
  };
  const run = (root: string, extraPath = '') =>
    spawnSync('bash', [path.join(root, 'scripts/training/init-env.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${extraPath}${process.env.PATH}`,
        APP_IMAGE: `ghcr.io/aliescoobs-sudo/kayas@sha256:${'a'.repeat(64)}`,
      },
    });
  it('refuses an existing file and an existing link (dangling or not), and writes nothing', () => {
    for (const plant of ['file', 'dangling', 'link']) {
      const root = setup();
      const victim = path.join(root, 'victim.txt');
      writeFileSync(victim, 'keep');
      if (plant === 'file') writeFileSync(path.join(root, '.env.training.ops'), 'mine');
      if (plant === 'dangling') symlinkSync(path.join(root, 'nowhere'), path.join(root, '.env.training'));
      if (plant === 'link') symlinkSync(victim, path.join(root, '.env.training.ops'));
      const r = run(root);
      expect(r.status, plant).toBe(1);
      expect(r.stderr, plant).toMatch(/not overwritten/);
      expect(readFileSync(victim, 'utf8')).toBe('keep');
      expect(existsSync(path.join(root, 'nowhere'))).toBe(false);
    }
  });
  it('a link planted AFTER the check (while the secrets are generated) is not followed, and the run leaves nothing behind', () => {
    const root = setup();
    const victim = path.join(root, 'victim.txt');
    writeFileSync(victim, 'keep');
    const realOpenssl = spawnSync('which', ['openssl'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    // the stub plants the link on its first call, then behaves as openssl
    writeFileSync(
      path.join(bin, 'openssl'),
      `#!/usr/bin/env bash\n[ -e "${root}/.planted" ] || { touch "${root}/.planted"; ln -s "${victim}" "${root}/.env.training"; }\nexec "${realOpenssl}" "$@"\n`,
      { mode: 0o755 },
    );
    const r = run(root, `${bin}:`);
    expect(r.status).not.toBe(0);
    expect(readFileSync(victim, 'utf8')).toBe('keep'); // the link was not written through
    expect(existsSync(path.join(root, '.env.training.ops'))).toBe(false);
  });
  it('the source creates exclusively (noclobber) with a private umask', () => {
    expect(initEnv).toMatch(/set -C/);
    expect(initEnv).toMatch(/umask 077/);
  });
});

describe('the seven mandatory conditions of R12, reduced to the local-only policy (R15A-06), are in both guides', () => {
  it.each([
    ['docs/checkpoints/CP-TRAINING.md', /Mandatory conditions before a supervised local exercise \(R12/],
    [
      'docs/checkpoints/CP-TRAINING-IMAC-FR.md',
      /Conditions obligatoires avant un exercice local surveillé \(R12/,
    ],
  ])('%s', (file, heading) => {
    const doc = readFileSync(file, 'utf8');
    expect(doc).toMatch(heading);
    const section = doc.slice(doc.search(heading));
    const numbered = [...section.matchAll(/^(\d)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(numbered).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const needle of ['show-accounts.sh', 'TRAINING_ALLOW_UNMARKED']) expect(section).toContain(needle);
  });
});
