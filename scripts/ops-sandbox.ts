import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A throwaway copy of the operator scripts in a real git repository with a real origin, a stub `docker` and `curl` on the PATH, and synthetic env files. It
// lets the tests drive the real shell scripts (dc.sh, ops.sh, bootstrap.sh, backup-nightly.sh, deploy.sh, verify-host.sh, ...) without Docker or a network.
// The stub docker records every call in docker.called, answers `compose ... config --format json` from config.json, `image inspect` from per-image answers, and
// can be told to fail particular calls. Nothing here holds a secret: the "secrets" are canary strings.
export const OWNER = 'aliescoobs-sudo';
export const sha = (c: string) => c.repeat(32);
export const IMG_A = `ghcr.io/${OWNER}/kayas@sha256:${sha('a1')}`;
export const IMG_B = `ghcr.io/${OWNER}/kayas@sha256:${sha('b2')}`;
export const PG =
  'postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

export interface Port {
  target: number;
  published: string;
  protocol: string;
  host_ip: string;
}
export interface Vol {
  type: string;
  source?: string;
  target?: string;
  read_only?: boolean;
}
export interface Svc {
  image?: string;
  platform?: string;
  ports?: Port[];
  volumes?: Vol[];
  cap_add?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  mem_limit?: number | string;
  pids_limit?: number | string;
  logging?: { driver?: string; options?: Record<string, string> };
  read_only?: boolean;
  environment: Record<string, string>;
  privileged?: boolean;
  network_mode?: string;
}
export interface Cfg {
  name: string;
  networks: Record<string, { internal?: boolean }>;
  services: Record<string, Svc>;
}

export const hardened = (extra: Partial<Svc> = {}): Svc => ({
  cap_drop: ['ALL'],
  security_opt: ['no-new-privileges:true'],
  mem_limit: 1_000_000_000,
  pids_limit: 200,
  logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
  read_only: true,
  environment: {},
  ...extra,
});
const stagingEnv = {
  APP_ENV: 'training',
  TRAINING_MODE: 'true',
  STAGING_PROFILE: 'true',
  REAL_DATA: 'false',
  SIMULATION_ENABLED: 'false',
  TRUSTED_PROXY_HOPS: '1',
  TRAINING_ALLOW_UNMARKED: 'false',
};
const dbCaps = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];
const ports80_443 = (): Port[] => [
  { target: 80, published: '80', protocol: 'tcp', host_ip: '0.0.0.0' },
  { target: 443, published: '443', protocol: 'tcp', host_ip: '0.0.0.0' },
];
const bind = (source: string, target: string, read_only = true): Vol => ({
  type: 'bind',
  source,
  target,
  read_only,
});

export function stagingConfig(
  image = IMG_A,
): Cfg & { services: { db: Svc; app: Svc; proxy: Svc; ops: Svc } } {
  return {
    name: 'kayas-staging',
    networks: { internal: { internal: true }, edge: {} },
    services: {
      db: hardened({
        image: PG,
        platform: 'linux/amd64',
        cap_add: dbCaps,
        volumes: [
          { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' },
          bind('/srv/kayas/scripts/training/db-init', '/docker-entrypoint-initdb.d'),
        ],
      }),
      app: hardened({
        image,
        platform: 'linux/amd64',
        environment: { ...stagingEnv, APP_BASE_URL: 'https://kayas.example.com' },
      }),
      proxy: hardened({
        image: 'caddy:2-alpine',
        environment: {
          APP_DOMAIN: 'kayas.example.com',
          STAGING_TLS: 'acme',
          STAGING_HTTP_PORT: '80',
          STAGING_HTTPS_PORT: '443',
        },
        cap_add: ['NET_BIND_SERVICE'],
        ports: ports80_443(),
        volumes: [
          bind('/srv/kayas/Caddyfile.staging', '/etc/caddy/Caddyfile'),
          bind('/srv/kayas/staging/basic-auth.caddy', '/etc/caddy/basic-auth.caddy'),
        ],
      }),
      ops: hardened({
        image,
        platform: 'linux/amd64',
        environment: {
          APP_ENV: 'training',
          TRAINING_MODE: 'true',
          STAGING_PROFILE: 'true',
          REAL_DATA: 'false',
          SIMULATION_ENABLED: 'false',
        },
      }),
    },
  };
}
export function prodConfig(
  image = IMG_A,
): Cfg & { services: { db: Svc; app: Svc; proxy: Svc; ops: Svc; bootstrap: Svc; backup: Svc } } {
  const real = { REAL_DATA: 'true', SIMULATION_ENABLED: 'false' };
  return {
    name: 'kayas',
    networks: { internal: { internal: true }, edge: {} },
    services: {
      db: hardened({ image: PG, cap_add: dbCaps }),
      app: hardened({ image, environment: { ...real, TRUSTED_PROXY_HOPS: '1' } }),
      proxy: hardened({
        image: 'caddy:2-alpine',
        cap_add: ['NET_BIND_SERVICE'],
        ports: ports80_443(),
        volumes: [bind('/srv/kayas/Caddyfile', '/etc/caddy/Caddyfile')],
      }),
      ops: hardened({
        image,
        read_only: false,
        environment: { ...real },
        volumes: [
          bind('/srv/kayas/backups', '/app/backups'),
          bind('/srv/kayas/imports', '/app/imports'),
          bind('/srv/kayas/keys', '/app/keys'),
          bind('/srv/kayas/reports', '/app/reports'),
        ],
      }),
      bootstrap: hardened({ image, read_only: false, environment: { ...real } }),
      backup: hardened({
        image,
        read_only: false,
        volumes: [bind('/srv/kayas/backups', '/app/backups', false)],
      }),
    },
  };
}

export interface Sandbox {
  root: string;
  bin: string;
  origin: string;
  head: string;
  /** run a script of the sandbox with the stub PATH */
  run: (
    script: string,
    args?: string[],
    env?: Record<string, string>,
    input?: string,
  ) => { status: number | null; stdout: string; stderr: string };
  called: () => string;
  /** the docker calls as lines */
  calls: () => string[];
  write: (rel: string, body: string, mode?: number) => void;
  read: (rel: string) => string;
  git: (...args: string[]) => string;
  /** commit a change and push it to origin/main; returns the new commit */
  commit: (rel: string, body: string) => string;
  /** the stub docker obeys these files: fail.<word> makes any call containing the word exit 1 */
  failOn: (word: string) => void;
  hangOn: (word: string) => void;
  /** the app is not ready (or the public route is down) while release/APPROVED contains this text */
  notReadyWhile: (text: string) => void;
  publicDownWhile: (text: string) => void;
  setConfig: (cfg: unknown) => void;
}

export function makeSandbox(
  opts: {
    stack?: 'prod' | 'staging';
    image?: string;
    approved?: boolean;
    config?: unknown;
    curlCode?: string;
  } = {},
): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-ops-'));
  const origin = mkdtempSync(path.join(tmpdir(), 'bb-origin-')) + '/o.git';
  const sh = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
        GIT_CONFIG_NOSYSTEM: '1',
      } as unknown as NodeJS.ProcessEnv,
    });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  spawnSync('git', ['init', '--bare', '-b', 'main', origin]);
  for (const d of ['scripts/ops', 'scripts/staging', 'scripts/training']) {
    mkdirSync(path.join(root, d), { recursive: true });
    cpSync(d, path.join(root, d), { recursive: true });
  }
  for (const f of ['docker-compose.prod.yml', 'docker-compose.staging.yml', 'Caddyfile', 'Caddyfile.staging'])
    cpSync(f, path.join(root, f));
  mkdirSync(path.join(root, 'staging'), { recursive: true });
  writeFileSync(
    path.join(root, '.gitignore'),
    '.env*\nrelease/APPROVED\nrelease/APPROVED.previous\nrelease/.deploy*\nrelease/evidence/\nbackups/\n.staging-evidence/\nstaging/basic-auth.caddy\nbin/\ndocker.called\nconfig.json\nfail.*\nhang.*\napp.notready\npublic.down\n',
  );
  sh(root, 'init', '-b', 'main');
  sh(root, 'remote', 'add', 'origin', origin);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  sh(root, 'push', '-q', 'origin', 'main');
  sh(root, 'fetch', '-q', 'origin');
  const head = sh(root, 'rev-parse', 'HEAD');
  const stack = opts.stack ?? 'prod';
  // env files
  const w = (rel: string, body: string, mode = 0o600) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body, { mode });
    chmodSync(path.join(root, rel), mode);
  };
  if (stack === 'prod') {
    w('.env.prod', 'AUTH_SECRET=canary-app-secret\n');
    w(
      '.env.ops.prod',
      'POSTGRES_SUPERUSER_PASSWORD=canary-super\nDATABASE_URL_MIGRATOR=postgres://m:canary@db/x\nAPP_DOMAIN=kayas.example.com\n',
    );
    w('.env.backup.prod', 'DATABASE_URL_BACKUP=postgres://b:canary@db/x\n');
  } else {
    w('.env.staging', 'APP_DOMAIN=kayas.example.com\nSTAGING_TLS=acme\nAUTH_SECRET=canary-app-secret\n');
    w('.env.staging.ops', 'POSTGRES_SUPERUSER_PASSWORD=canary-super\n');
    w(
      'staging/basic-auth.caddy',
      'basic_auth bcrypt "x" {\n\tu $2a$14$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n}\n',
    );
  }
  mkdirSync(path.join(root, 'release'), { recursive: true });
  if (opts.approved !== false) {
    w(
      'release/APPROVED',
      `COMMIT=${head}\nIMAGE=${opts.image ?? IMG_A}\nPLATFORM=linux/amd64\nRUN_ID=123456\n`,
      0o640,
    );
  }
  // stubs
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "$* | APP_IMAGE=\${APP_IMAGE-unset}" >> "${root}/docker.called"
for f in "${root}"/hang.*; do [ -e "$f" ] || continue; w="$(cat "$f")"; case "$*" in *"$w"*) sleep 60; exit 1;; esac; done
for f in "${root}"/fail.*; do [ -e "$f" ] || continue; w="$(cat "$f")"; case "$*" in *"$w"*) exit 1;; esac; done
case "$*" in
  *" config --format json") cur="$(sed -n 's/^IMAGE=//p' "${root}/release/APPROVED" 2>/dev/null)"; sed "s#${IMG_A}#\${cur:-${IMG_A}}#g" "${root}/config.json"; exit 0;;
  "image inspect --format {{.Os}}/{{.Architecture}} "*) echo "\${DOCKER_STUB_PLATFORM:-linux/amd64}"; exit 0;;
  "image inspect --format {{.Id}} "*) echo "sha256:stubimageid\${DOCKER_STUB_ID_SUFFIX:-}"; exit 0;;
  "inspect --format {{.Config.Image}}|{{.Image}}|{{.State.ExitCode}} "*) echo "\${DOCKER_STUB_ACTUAL_IMAGE:-$(sed -n 's/^IMAGE=//p' "${root}/release/APPROVED" 2>/dev/null)}|sha256:stubimageid|0"; exit 0;;
  "ps -aq --no-trunc") if [ -e "${root}/ps.fail" ]; then exit 1; fi; cat "${root}/ps.ids" 2>/dev/null; exit 0;;
  "inspect "*) if [ -e "${root}/inspect.fail" ]; then exit 1; fi; cat "${root}/inspect.json" 2>/dev/null; exit 0;;
  *"hash-password"*) cat > "${root}/stdin.log"; echo '$2a$14$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'; exit 0;;
  *"exec -T app wget"*) if [ -s "${root}/app.notready" ] && grep -q -f "${root}/app.notready" "${root}/release/APPROVED"; then exit 1; fi; echo '{"status":"ready"}'; exit 0;;
esac
exit 0
`,
  );
  writeFileSync(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
echo "curl $*" >> "${root}/docker.called"
if [ -s "${root}/public.down" ] && grep -q -f "${root}/public.down" "${root}/release/APPROVED"; then printf '000'; exit 7; fi
printf '${opts.curlCode ?? '200'}'
`,
  );
  chmodSync(path.join(bin, 'docker'), 0o755);
  chmodSync(path.join(bin, 'curl'), 0o755);
  writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify(
      opts.config ??
        (stack === 'prod' ? prodConfig(opts.image ?? IMG_A) : stagingConfig(opts.image ?? IMG_A)),
    ),
  );
  let n = 0;
  const sb: Sandbox = {
    root,
    bin,
    origin,
    head,
    run: (script, args = [], env = {}, input) => {
      const r = spawnSync('bash', [path.join(root, script), ...args], {
        cwd: root,
        encoding: 'utf8',
        input,
        env: {
          PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
          HOME: root,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@x',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@x',
          READY_TRIES: '2',
          READY_SLEEP: '0',
          ...env,
        } as unknown as NodeJS.ProcessEnv,
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    called: () =>
      existsSync(path.join(root, 'docker.called'))
        ? readFileSync(path.join(root, 'docker.called'), 'utf8')
        : '',
    calls: () => sb.called().split('\n').filter(Boolean),
    write: w,
    read: (rel) => readFileSync(path.join(root, rel), 'utf8'),
    git: (...a) => sh(root, ...a),
    commit: (rel, body) => {
      writeFileSync(path.join(root, rel), body);
      sh(root, 'add', '-A');
      sh(root, 'commit', '-qm', `change ${rel}`);
      sh(root, 'push', '-q', 'origin', 'main');
      return sh(root, 'rev-parse', 'HEAD');
    },
    failOn: (word) => writeFileSync(path.join(root, `fail.${++n}`), word),
    hangOn: (word) => writeFileSync(path.join(root, `hang.${++n}`), word),
    notReadyWhile: (text) => writeFileSync(path.join(root, 'app.notready'), text + '\n'),
    publicDownWhile: (text) => writeFileSync(path.join(root, 'public.down'), text + '\n'),
    setConfig: (cfg) => writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg)),
  };
  return sb;
}
export const approvedText = (commit: string, image = IMG_A, run = '123456') =>
  `COMMIT=${commit}\nIMAGE=${image}\nPLATFORM=linux/amd64\nRUN_ID=${run}\n`;
