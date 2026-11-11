import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// R17-01: the image that is validated is the image that runs. Stubbed docker, synthetic env files, no network. A stub records every call and the
// APP_IMAGE / COMPOSE_* it was called with, so the binding can be asserted without ever printing an environment.
const OWNER = 'aliescoobs-sudo';
const GOOD = `ghcr.io/${OWNER}/kayas@sha256:${'a1'.repeat(32)}`;
const OTHER = `ghcr.io/${OWNER}/kayas@sha256:${'b2'.repeat(32)}`;
const PG = 'postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

/** The services compose resolves, as `config` prints them (service names with their image lines; nothing else is read from it). */
type Resolved = [service: string, image: string][];
const DEFAULT_RESOLVED: Resolved = [
  ['db', PG],
  ['app', GOOD],
  ['proxy', 'caddy:2-alpine'],
  ['ops', GOOD],
];

function sandbox(opts: { env?: string; ops?: string; resolved?: Resolved; dockerBody?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-effimg-'));
  mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
  for (const f of ['image-policy.sh', 'dc.sh', 'ops.sh', 'running-image.sh'])
    copyFileSync(`scripts/training/${f}`, path.join(root, 'scripts/training', f));
  copyFileSync('scripts/training-up.sh', path.join(root, 'scripts/training-up.sh'));
  writeFileSync(path.join(root, '.env.training'), opts.env ?? `APP_IMAGE=${GOOD}\n`, { mode: 0o600 });
  writeFileSync(path.join(root, '.env.training.ops'), opts.ops ?? 'X=1\n', { mode: 0o600 });
  writeFileSync(path.join(root, 'docker-compose.training.yml'), 'services: {}\n');
  const yaml = `name: kayas-training\nservices:\n${(opts.resolved ?? DEFAULT_RESOLVED)
    .map(
      ([svc, img]) => `  ${svc}:\n    image: ${img}\n    environment:\n      SECRET: must-never-be-printed\n`,
    )
    .join('')}`.replace(/\n/g, '\\n');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "$* | APP_IMAGE=\${APP_IMAGE-unset} COMPOSE_FILE=\${COMPOSE_FILE-unset}" >> "${root}/docker.called"
${opts.dockerBody ?? ''}
case "$*" in *" config") printf '${yaml}';; esac
exit 0
`,
  );
  chmodSync(path.join(bin, 'docker'), 0o755);
  return { root, bin };
}
const run = (
  s: { root: string; bin: string },
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
) =>
  spawnSync('bash', [path.join(s.root, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, READY_TRIES: '1', READY_SLEEP: '0', ...env },
  });
const calls = (s: { root: string }) =>
  existsSync(path.join(s.root, 'docker.called'))
    ? readFileSync(path.join(s.root, 'docker.called'), 'utf8')
    : '';

describe('R17-01: a good file and a bad exported value', () => {
  it.each([
    ['dc.sh', 'scripts/training/dc.sh', ['pull']],
    ['ops.sh', 'scripts/training/ops.sh', ['db-migrate']],
    ['training-up.sh', 'scripts/training-up.sh', []],
  ] as const)(
    '%s refuses an APP_IMAGE exported in the shell (a tag, another digest, even the same one) and calls no docker',
    (_n, script, args) => {
      for (const bad of [`ghcr.io/${OWNER}/kayas:latest`, OTHER, GOOD]) {
        const s = sandbox();
        const r = run(s, script, [...args], { APP_IMAGE: bad });
        expect(r.status, `${script} ${bad}`).toBe(1);
        expect(r.stderr).toMatch(/APP_IMAGE is set in the shell/);
        expect(calls(s)).not.toMatch(/compose/);
        expect(r.stdout + r.stderr).not.toContain('b2b2b2'); // the value is not echoed
      }
    },
  );

  it('a second env file that sets APP_IMAGE (plain or exported) is refused', () => {
    for (const line of [`APP_IMAGE=${OTHER}`, `export APP_IMAGE=${OTHER}`, `  APP_IMAGE = ${OTHER}`]) {
      const s = sandbox({ ops: `X=1\n${line}\n` });
      const r = run(s, 'scripts/training/dc.sh', ['pull']);
      expect(r.status, line).toBe(1);
      expect(r.stderr).toMatch(/\.env\.training\.ops sets APP_IMAGE/);
      expect(calls(s)).toBe('');
    }
  });

  it('duplicate keys in the first file are refused (docker would take the last, a script the first)', () => {
    const s = sandbox({ env: `APP_IMAGE=${GOOD}\nAPP_IMAGE=${OTHER}\n` });
    const r = run(s, 'scripts/training/dc.sh', ['pull']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exactly once/);
    expect(calls(s)).toBe('');
  });

  it.each([
    ['-f', 'other.yml'],
    ['--file', 'other.yml'],
    ['--file=other.yml'],
    ['--env-file', 'x.env'],
    ['--env-file=x.env'],
    ['-p', 'other'],
    ['--project-name', 'other'],
    ['--project-directory', '/tmp'],
    ['--profile', 'x'],
    ['--ansi', 'never'],
    ['--ansi=never'],
    ['--parallel', '1'],
    ['--progress', 'plain'],
    ['--verbose'],
    ['--dry-run'],
    ['-H', 'tcp://evil:2375'],
  ])('R18-10: a compose option %s BEFORE the sub-command is refused, and nothing executes', (...opt) => {
    const s = sandbox();
    const r = run(s, 'scripts/training/dc.sh', [...opt, 'pull']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not an allowed first argument/);
    expect(calls(s)).toBe('');
  });

  it("R18-10: the review's exploit — a valued global option hiding an override file with another ops image — is refused with no docker call at all", () => {
    for (const argv of [
      ['--ansi', 'never', '-f', 'override.yml', 'run', '--rm', 'ops', 'node', 'x.ts'],
      ['-p', 'x', '-f', 'override.yml', 'up', '-d'],
      ['--env-file', 'other.env', 'run', '--rm', 'ops', 'sh'],
      ['--project-directory', '/tmp/evil', 'up', '-d', 'app'],
    ]) {
      const s = sandbox();
      writeFileSync(path.join(s.root, 'override.yml'), `services:\n  ops:\n    image: ${OTHER}\n`);
      const r = run(s, 'scripts/training/dc.sh', argv);
      expect(r.status, argv.join(' ')).toBe(1);
      expect(calls(s), argv.join(' ')).toBe('');
    }
  });

  it('R18-10: only the allow-listed sub-commands run, and an empty command line is refused', () => {
    for (const sub of ['config', 'pull', 'ps', 'logs', 'stop', 'up', 'exec', 'run']) {
      const s = sandbox();
      const r = run(s, 'scripts/training/dc.sh', [sub]);
      expect(r.status, `${sub}: ${r.stderr}`).toBe(0);
    }
    for (const sub of ['down', 'build', 'cp', 'kill', 'rm', 'create', 'exec-all', 'CONFIG', '-', '']) {
      const s = sandbox();
      const r = run(s, 'scripts/training/dc.sh', sub === '' ? [] : [sub, 'x']);
      expect(r.status, sub).toBe(1);
      expect(calls(s), sub).toBe('');
    }
  });

  it('R18-10: stop-all and up-public are the composed commands; the profiles are added by the script, never by the caller', () => {
    const s = sandbox();
    expect(run(s, 'scripts/training/dc.sh', ['stop-all']).status).toBe(0);
    expect(calls(s).trim().split('\n').at(-1)).toMatch(/--profile public --profile ops stop \|/);
    const t = sandbox();
    expect(run(t, 'scripts/training/dc.sh', ['up-public']).status).toBe(0);
    expect(calls(t).trim().split('\n').at(-1)).toMatch(/--profile public up -d \|/);
  });

  it('what follows the subcommand belongs to the command (a script argument -f is not a compose option)', () => {
    const s = sandbox();
    const r = run(s, 'scripts/training/dc.sh', ['run', '--rm', 'ops', 'node', 'x.ts', '-f']);
    expect(r.status, r.stderr).toBe(0);
  });

  it('the validated value is PASSED to compose, and COMPOSE_FILE from the shell is dropped', () => {
    const s = sandbox();
    const r = run(s, 'scripts/training/dc.sh', ['pull'], { COMPOSE_FILE: 'evil.yml' });
    expect(r.status, r.stderr).toBe(0);
    const log = calls(s).trim().split('\n');
    expect(log.length).toBe(2); // the resolution of the configuration, then the command
    for (const l of log) {
      expect(l).toContain(`APP_IMAGE=${GOOD}`);
      expect(l).toContain('COMPOSE_FILE=unset');
    }
    // the SAME files and env files for the check and for the command
    const prefix =
      'compose -f docker-compose.training.yml --env-file .env.training --env-file .env.training.ops';
    expect(log[0]).toContain(`${prefix} --profile public --profile ops config`);
    expect(log[1]).toContain(`${prefix} pull`);
  });

  it('R18-10: the app and the ops images are resolved SERVICE BY SERVICE: another digest, a tag or an unknown image for either is refused before the command runs', () => {
    const bad: Resolved[] = [
      [
        ['db', PG],
        ['app', GOOD],
        ['ops', OTHER],
      ],
      [
        ['db', PG],
        ['app', OTHER],
        ['ops', GOOD],
      ],
      [
        ['db', PG],
        ['app', GOOD],
        ['ops', `ghcr.io/${OWNER}/kayas:latest`],
      ],
      [
        ['db', PG],
        ['app', GOOD],
        ['ops', 'evil/image:1'],
      ],
      [
        ['db', PG],
        ['app', 'evil/image:1'],
        ['ops', GOOD],
      ],
      [
        ['db', 'postgres:17'],
        ['app', GOOD],
        ['ops', GOOD],
      ],
      [
        ['db', PG],
        ['app', GOOD],
        ['ops', GOOD],
        ['proxy', 'evil/proxy:1'],
      ],
      [
        ['db', PG],
        ['app', GOOD],
        ['ops', GOOD],
        ['sidecar', GOOD],
      ],
    ];
    for (const resolved of bad) {
      const s = sandbox({ resolved });
      const r = run(s, 'scripts/training/dc.sh', ['run', '--rm', 'ops', 'sh']);
      expect(r.status, JSON.stringify(resolved)).toBe(1);
      expect(calls(s)).not.toMatch(/ run --rm/);
      expect(r.stdout + r.stderr).not.toContain('must-never-be-printed');
    }
  });

  it('R18-10: a missing app or ops service (or a service with no image) is refused, not skipped', () => {
    for (const resolved of [
      [
        ['db', PG],
        ['ops', GOOD],
      ],
      [
        ['db', PG],
        ['app', GOOD],
      ],
      [
        ['db', PG],
        ['app', GOOD],
        ['ops', ''],
      ],
      [] as Resolved,
    ] as Resolved[]) {
      const s = sandbox({ resolved });
      const r = run(s, 'scripts/training/dc.sh', ['up', '-d']);
      expect(r.status, JSON.stringify(resolved)).toBe(1);
      expect(calls(s)).not.toMatch(/ up -d/);
    }
  });

  it('a compose that cannot resolve its configuration stops the command', () => {
    const s = sandbox({ dockerBody: 'case "$*" in *" config") exit 1;; esac' });
    const r = run(s, 'scripts/training/dc.sh', ['up', '-d']);
    expect(r.status).toBe(1);
    expect(calls(s)).not.toMatch(/ up -d/);
  });
});

describe('R17-01/10: running-image.sh compares, and tells a failed query from absence', () => {
  const body = (containers: string) => `case "$*" in
  *"ps -q app"*) printf '${containers}';;
  *"ps -q ops"*) ;;
  *"inspect"*) case "$*" in *c1*) echo "${GOOD} sha256:id1";; *c2*) echo "${OTHER} sha256:id2";; esac;; esac`;
  it('says "matches" for the configured digest and MISMATCH for another one, for every container returned', () => {
    const s = sandbox({ dockerBody: body('c1\\nc2\\n') });
    const r = run(s, 'scripts/training/running-image.sh');
    expect(r.stdout).toMatch(/app: .*id1 \(matches the configured digest\)/);
    expect(r.stdout).toMatch(/app: .*id2 \(MISMATCH: not the configured digest\)/);
    expect(r.stdout).toMatch(/ops: not running/);
    expect(r.stdout).not.toMatch(/accepted digest/);
    expect(r.status).toBe(1);
  });
  it('a query that fails is reported as a failure (exit 2), not as "not running"', () => {
    const s = sandbox({ dockerBody: 'case "$*" in *"ps -q"*) exit 1;; esac' });
    const r = run(s, 'scripts/training/running-image.sh');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/QUERY FAILED/);
    expect(r.stdout).not.toMatch(/not running/);
  });
  it('a configured image the policy refuses stops it', () => {
    const s = sandbox({ env: `APP_IMAGE=ghcr.io/${OWNER}/kayas:latest\n` });
    expect(run(s, 'scripts/training/running-image.sh').status).toBe(1);
  });
});
