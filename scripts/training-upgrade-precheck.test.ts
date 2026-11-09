import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// R16-04: training-up.sh detects a pre-KAYAS stack (old compose project, volumes, or another owner of the port) and stops, instead of silently
// starting a second stack. Stub docker: no docker, no network.
const GOOD = `ghcr.io/aliescoobs-sudo/kayas@sha256:${'a'.repeat(64)}`;

function run(docker: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-precheck-'));
  mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
  copyFileSync('scripts/training-up.sh', path.join(root, 'scripts/training-up.sh'));
  copyFileSync('scripts/training/image-policy.sh', path.join(root, 'scripts/training/image-policy.sh'));
  const stub = (name: string, body: string) =>
    writeFileSync(path.join(root, 'scripts/training', name), `#!/usr/bin/env bash\n${body}\n`, {
      mode: 0o755,
    });
  stub(
    'dc.sh',
    `echo "$*" >> "${root}/dc.called"\ncase "$*" in *"exec -T app wget"*) echo '{"status":"ready"}';; esac`,
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
  return { r, started: existsSync(path.join(root, 'dc.called')) };
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
