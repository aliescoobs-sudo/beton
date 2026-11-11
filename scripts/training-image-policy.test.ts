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

// R16-03: the training startup runs ONLY an image that is exactly ghcr.io/<expected owner>/kayas@sha256:<64 lowercase hex>. One validator
// (scripts/training/image-policy.sh), used before any pull, bootstrap or seed. Source-level stub tests: no docker, no network.
const OWNER = 'aliescoobs-sudo';
const HEX = 'a1'.repeat(32);
const GOOD = `ghcr.io/${OWNER}/kayas@sha256:${HEX}`;

const check = (ref: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', '. ./scripts/training/image-policy.sh; kayas_check_image "$1" t', 'x', ref], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

describe('image-policy.sh: accepted and refused references', () => {
  it('accepts the exact owner, package and a 64-character lowercase hex digest', () => {
    const r = check(GOOD);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
  });
  const refused: [string, string][] = [
    ['a mutable tag', `ghcr.io/${OWNER}/kayas:latest`],
    ['a version tag', `ghcr.io/${OWNER}/kayas:v1.2.3`],
    ['a tag and a digest', `ghcr.io/${OWNER}/kayas:latest@sha256:${HEX}`],
    ['no digest', `ghcr.io/${OWNER}/kayas`],
    ['uppercase hex', `ghcr.io/${OWNER}/kayas@sha256:${HEX.toUpperCase()}`],
    ['63 hex characters', `ghcr.io/${OWNER}/kayas@sha256:${HEX.slice(1)}`],
    ['65 hex characters', `ghcr.io/${OWNER}/kayas@sha256:${HEX}a`],
    ['a non-hex character', `ghcr.io/${OWNER}/kayas@sha256:${HEX.slice(0, 63)}g`],
    ['another algorithm', `ghcr.io/${OWNER}/kayas@sha512:${HEX}`],
    ['another owner', `ghcr.io/someone-else/kayas@sha256:${HEX}`],
    ['an owner that only starts like ours', `ghcr.io/${OWNER}2/kayas@sha256:${HEX}`],
    ['an owner with ours as a suffix', `ghcr.io/x${OWNER}/kayas@sha256:${HEX}`],
    ['another package', `ghcr.io/${OWNER}/kayas-evil@sha256:${HEX}`],
    ['the former package name', `ghcr.io/${OWNER}/belgobeton@sha256:${HEX}`],
    ['a sub-path', `ghcr.io/${OWNER}/kayas/x@sha256:${HEX}`],
    ['another registry', `docker.io/${OWNER}/kayas@sha256:${HEX}`],
    ['a registry that only contains ours', `evil.ghcr.io/${OWNER}/kayas@sha256:${HEX}`],
    ['a leading space', ` ${GOOD}`],
    ['a trailing space', `${GOOD} `],
    ['a trailing line with another image', `${GOOD}\nghcr.io/evil/kayas@sha256:${HEX}`],
    ['an empty value', ''],
  ];
  for (const [name, ref] of refused)
    it(`refuses ${name}`, () => {
      const r = check(ref);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refused image reference|APP_IMAGE is empty/);
    });

  it('the expected owner is a constant of the file: an exported variable cannot widen it', () => {
    const r = check(`ghcr.io/evil/kayas@sha256:${HEX}`, {
      KAYAS_IMAGE_OWNER: 'evil',
      KAYAS_IMAGE_PATTERN: '.*',
    });
    expect(r.status).toBe(1);
    expect(readFileSync('scripts/training/image-policy.sh', 'utf8')).toMatch(
      /^KAYAS_IMAGE_OWNER="[a-z0-9-]+"$/m,
    );
  });

  it('kayas_require_image prints the accepted digest, and only the digest', () => {
    const r = spawnSync(
      'bash',
      ['-c', '. ./scripts/training/image-policy.sh; kayas_require_image "$1" t', 'x', GOOD],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`digest sha256:${HEX}`);
  });
});

describe('every entry point refuses a refused image before doing anything', () => {
  const sandbox = (image: string | null) => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-imgpol-'));
    mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
    for (const f of ['image-policy.sh', 'dc.sh', 'ops.sh', 'init-env.sh'])
      copyFileSync(`scripts/training/${f}`, path.join(root, 'scripts/training', f));
    copyFileSync('scripts/training-up.sh', path.join(root, 'scripts/training-up.sh'));
    if (image !== null) {
      writeFileSync(path.join(root, '.env.training'), `APP_IMAGE=${image}\n`, { mode: 0o600 });
      writeFileSync(path.join(root, '.env.training.ops'), 'X=1\n', { mode: 0o600 });
    }
    // a docker that records any call: a refused image must never reach it
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/usr/bin/env bash\necho "$*" >> "${root}/docker.called"\ncase "$*" in *" config") printf 'services:\\n  app:\\n    image: ${image ?? ''}\\n  ops:\\n    image: ${image ?? ''}\\n';; esac\nexit 0\n`,
    );
    chmodSync(path.join(bin, 'docker'), 0o755);
    return { root, bin };
  };
  const run = (
    root: string,
    bin: string,
    script: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ) =>
    spawnSync('bash', [path.join(root, script), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });

  for (const bad of [
    `ghcr.io/${OWNER}/kayas:latest`,
    `ghcr.io/evil/kayas@sha256:${HEX}`,
    `ghcr.io/${OWNER}/kayas@sha256:${HEX.toUpperCase()}`,
  ]) {
    it(`training-up.sh, dc.sh and ops.sh stop before any docker call on ${bad.slice(0, 40)}…`, () => {
      for (const [script, args] of [
        ['scripts/training-up.sh', []],
        ['scripts/training/dc.sh', ['pull']],
        ['scripts/training/ops.sh', ['db-migrate']],
      ] as const) {
        const { root, bin } = sandbox(bad);
        const r = run(root, bin, script, [...args]);
        expect(r.status, `${script}: ${r.stderr}`).toBe(1);
        expect(r.stderr).toMatch(/refused image reference/);
        expect(existsSync(path.join(root, 'docker.called')), script).toBe(false);
      }
    });
  }

  it('init-env.sh refuses a tag and creates no file', () => {
    const { root, bin } = sandbox(null);
    const r = run(root, bin, 'scripts/training/init-env.sh', [], {
      APP_IMAGE: `ghcr.io/${OWNER}/kayas:latest`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused image reference/);
    expect(existsSync(path.join(root, '.env.training'))).toBe(false);
    expect(existsSync(path.join(root, '.env.training.ops'))).toBe(false);
  });

  it('a file with no APP_IMAGE at all is refused too', () => {
    const { root, bin } = sandbox('');
    const r = run(root, bin, 'scripts/training-up.sh');
    expect(r.status).toBe(1);
    expect(existsSync(path.join(root, 'docker.called'))).toBe(false);
  });

  it('dc.sh with the accepted digest reaches docker compose', () => {
    const { root, bin } = sandbox(GOOD);
    const r = run(root, bin, 'scripts/training/dc.sh', ['pull']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(root, 'docker.called'), 'utf8')).toMatch(/compose .*pull/);
  });
});

describe('pick-image.sh and running-image.sh use the same rule', () => {
  it('pick-image.sh sources the shared validator and keeps no pattern of its own', () => {
    const pick = readFileSync('scripts/training/pick-image.sh', 'utf8');
    expect(pick).toContain('image-policy.sh');
    expect(pick).toContain('kayas_check_image');
    expect(pick).not.toMatch(/sha256:\?{10}/);
  });
  it('running-image.sh reads only the image reference and id from docker, never the environment', () => {
    const s = readFileSync('scripts/training/running-image.sh', 'utf8');
    expect(s).toContain("docker inspect --format '{{.Config.Image}} {{.Image}}'");
    expect(s).not.toMatch(/\.Config\.Env|inspect "\$|docker (compose )?config|printenv|\benv\b\s*\|/);
  });
});
