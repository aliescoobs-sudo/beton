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

// R16-04: training-up.sh detects a pre-KAYAS stack (old compose project, volumes, or another owner of the port) and stops, instead of silently
// starting a second stack. Stub docker: no docker, no network.
const GOOD = `ghcr.io/aliescoobs-sudo/kayas@sha256:${'a'.repeat(64)}`;

function run(docker: string, cfgPort = '3000', config: 'ok' | 'fails' | 'no-port' = 'ok') {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-precheck-'));
  mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
  copyFileSync('scripts/training-up.sh', path.join(root, 'scripts/training-up.sh'));
  copyFileSync('scripts/training/image-policy.sh', path.join(root, 'scripts/training/image-policy.sh'));
  const stub = (name: string, body: string) =>
    writeFileSync(path.join(root, 'scripts/training', name), `#!/usr/bin/env bash\n${body}\n`, {
      mode: 0o755,
    });
  const goodConfig = `printf 'name: kayas-training\\nservices:\\n  db:\\n    image: x\\n  app:\\n    ports:\\n      - mode: ingress\\n        host_ip: 127.0.0.1\\n        target: 3000\\n        published: "${cfgPort}"\\n        protocol: tcp\\n    environment:\\n      SECRET: must-never-be-printed\\n'`;
  const noPortConfig = `printf 'name: kayas-training\\nservices:\\n  app:\\n    environment:\\n      SECRET: must-never-be-printed\\n'`;
  // R19: `config` is the one call whose answer the script parses; the three stubs are a readable answer, a failing command and an answer with no published port
  const configAnswer = config === 'fails' ? 'exit 1' : config === 'no-port' ? noPortConfig : goodConfig;
  stub(
    'dc.sh',
    `echo "$*" >> "${root}/dc.called"\ncase "$*" in *"exec -T app wget"*) echo '{"status":"ready"}';; config) ${configAnswer};; esac`,
  );
  stub('ops.sh', 'exit 0');
  writeFileSync(path.join(root, '.env.training'), `APP_IMAGE=${GOOD}\n`, { mode: 0o600 });
  writeFileSync(path.join(root, '.env.training.ops'), 'X=1\n', { mode: 0o600 });
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\n${docker}\n`);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const r = spawnSync('bash', [path.join(root, 'scripts/training-up.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, READY_TRIES: '1', READY_SLEEP: '0' },
  });
  const called = existsSync(path.join(root, 'dc.called'))
    ? readFileSync(path.join(root, 'dc.called'), 'utf8')
    : '';
  return { r, started: /^pull/m.test(called) };
}

describe('training-up.sh pre-check of a pre-KAYAS stack', () => {
  it('stops on a container of the old project, and starts nothing', () => {
    const { r, started } = run(`case "$*" in *"ps -a -q"*belgobeton-training*) echo abc123;; esac; exit 0`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/pre-KAYAS training stack \(belgobeton-training\)/);
    expect(r.stderr).toMatch(/Upgrading a pre-KAYAS training install/);
    expect(started).toBe(false);
  });
  it('stops on a volume of the old project even when no container is left', () => {
    const { r, started } = run(
      `case "$*" in *"volume ls"*belgobeton-training*) echo belgobeton-training_pgdata;; esac; exit 0`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/pre-KAYAS training stack/);
    expect(started).toBe(false);
  });
  it('stops when another container, not the KAYAS stack, publishes the port, and names it', () => {
    const { r, started } = run(
      `case "$*" in *"publish=3000"*) echo 'old-app-1|belgobeton-training';; esac; exit 0`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/port 3000 is already published by another container \(old-app-1\)/);
    expect(started).toBe(false);
  });
  it('a stranger holding the port is refused too', () => {
    const { r } = run(`case "$*" in *"publish=3000"*) echo 'devserver|';; esac; exit 0`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/devserver/);
  });
  it('the KAYAS stack itself holding the port (a restart) is fine', () => {
    const { r, started } = run(
      `case "$*" in *"publish=3000"*) echo 'kayas-training-app-1|kayas-training';; esac; exit 0`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(started).toBe(true);
  });
  it('a clean machine starts normally', () => {
    const { r, started } = run('exit 0');
    expect(r.status, r.stderr).toBe(0);
    expect(started).toBe(true);
  });
});

describe('R17-10: the effective configuration, and a docker that does not answer', () => {
  it('the port is the one the compose configuration publishes, not the shell default: a holder of 3456 is found', () => {
    const { r, started } = run(`case "$*" in *"publish=3456"*) echo 'devserver|';; esac; exit 0`, '3456');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/port 3456 is already published by another container \(devserver\)/);
    expect(started).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('must-never-be-printed');
  });
  it('the old port 3000 is not checked when the configuration publishes another one', () => {
    const { r } = run(`case "$*" in *"publish=3000"*) echo 'devserver|';; esac; exit 0`, '3456');
    expect(r.status, r.stderr).toBe(0);
  });
  it.each([
    ['containers of the old project', 'ps -a -q'],
    ['volumes of the old project', 'volume ls'],
    ['the holders of the port', 'publish='],
  ])('a failing inventory of %s refuses the start (it is not "absent")', (_n, needle) => {
    const { r } = run(`case "$*" in *"${needle}"*) exit 1;; esac; exit 0`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/inventory .* failed; this is not an empty answer/);
  });
  it('EVERY holder is inspected, not the first: a stranger after the KAYAS stack is refused', () => {
    const { r } = run(
      `case "$*" in *"publish=3000"*) printf 'kayas-training-app-1|kayas-training\\ndevserver|\\n';; esac; exit 0`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/devserver/);
  });
  it('control: with a readable configuration the start goes on (so the refusals below are about the configuration)', () => {
    const ok = run('exit 0');
    expect(ok.r.status, ok.r.stderr).toBe(0);
    expect(ok.started).toBe(true);
  });
  it('a configuration that cannot be read (the command fails) stops the start, and nothing is started', () => {
    const { r, started } = run('exit 0', '3000', 'fails');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read the effective compose configuration; nothing was started/);
    expect(started).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('must-never-be-printed');
  });
  it('a configuration with no published port stops the start, and nothing is started', () => {
    const { r, started } = run('exit 0', '3000', 'no-port');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /could not read the published port of the app from the compose configuration; nothing was started/,
    );
    expect(started).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('must-never-be-printed');
  });
});
