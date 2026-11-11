import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// R18-11: every ops execution (a run-once container, removed afterwards) leaves evidence of the ACTUAL image it ran: approved commit / digest / platform
// next to the container's own image reference, image id and platform, for the start and the end of each job. Stubbed docker, synthetic env files.
const OWNER = 'aliescoobs-sudo';
const GOOD = `ghcr.io/${OWNER}/kayas@sha256:${'a1'.repeat(32)}`;
const OTHER = `ghcr.io/${OWNER}/kayas@sha256:${'b2'.repeat(32)}`;
const PG = 'postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const COMMIT = 'c0ffee'.repeat(6) + 'abcd';
const IMAGE_ID = `sha256:${'f3'.repeat(32)}`;

function sandbox(opts: { platform?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-opsev-'));
  mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
  for (const f of ['image-policy.sh', 'dc.sh', 'ops.sh'])
    copyFileSync(`scripts/training/${f}`, path.join(root, 'scripts/training', f));
  copyFileSync('scripts/training-up.sh', path.join(root, 'scripts/training-up.sh'));
  writeFileSync(
    path.join(root, '.env.training'),
    `APP_IMAGE=${GOOD}\nAPP_COMMIT=${COMMIT}\nAPP_PLATFORM=${opts.platform ?? 'linux/amd64'}\nSECRET_TOKEN=must-never-be-recorded\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(root, '.env.training.ops'), 'X=1\n', { mode: 0o600 });
  writeFileSync(path.join(root, 'docker-compose.training.yml'), 'services: {}\n');
  const yaml = [
    ['db', PG],
    ['app', GOOD],
    ['ops', GOOD],
  ]
    .map(([s, i]) => `  ${s}:\\n    image: ${i}\\n`)
    .join('');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(path.join(root, 'containers'));
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "$*" >> "${root}/docker.called"
case "$*" in
  *" config") printf 'services:\\n${yaml}';;
  *" run "*)
    name=""; prev=""
    for a in "$@"; do [ "$prev" = "--name" ] && name="$a"; prev="$a"; done
    printf '%s|%s|%s' "\${STUB_ACTUAL_IMAGE:-${GOOD}}" "${IMAGE_ID}" "\${STUB_RUN_RC:-0}" > "${root}/containers/$name"
    exit "\${STUB_RUN_RC:-0}";;
  "inspect "*)
    [ -n "\${STUB_INSPECT_FAIL:-}" ] && exit 1
    name="\${@: -1}"; [ -f "${root}/containers/$name" ] && cat "${root}/containers/$name";;
  "image inspect "*) printf '%s' "\${STUB_PLATFORM:-linux/amd64}";;
  "rm "*) name="\${@: -1}"; rm -f "${root}/containers/$name";;
esac
exit 0
`,
  );
  chmodSync(path.join(bin, 'docker'), 0o755);
  return { root, bin };
}
const run = (s: { root: string; bin: string }, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [path.join(s.root, 'scripts/training/ops.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, ...env },
  });
const evidence = (s: { root: string }) =>
  existsSync(path.join(s.root, '.training-evidence/ops-executions.jsonl'))
    ? readFileSync(path.join(s.root, '.training-evidence/ops-executions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, string>)
    : [];
const calls = (s: { root: string }) =>
  existsSync(path.join(s.root, 'docker.called'))
    ? readFileSync(path.join(s.root, 'docker.called'), 'utf8')
    : '';

describe('R18-11: a disposable upgrade records the image of each completed ops job', () => {
  it('the four jobs of a start-up (prepare-out, db-bootstrap, db-migrate, seed-training) each leave a start and an end line with the ACTUAL image, and the containers are removed', () => {
    const s = sandbox();
    for (const job of [['--prepare-out'], ['db-bootstrap'], ['db-migrate'], ['seed-training']]) {
      const r = run(s, job);
      expect(r.status, `${job[0]}: ${r.stderr}`).toBe(0);
    }
    const lines = evidence(s);
    expect(lines).toHaveLength(8);
    const ends = lines.filter((l) => l.event === 'end');
    expect(ends.map((l) => l.job)).toEqual(['prepare-out', 'db-bootstrap', 'db-migrate', 'seed-training']);
    for (const e of ends) {
      expect(e).toMatchObject({
        exit: '0',
        container_exit: '0',
        actual_digest: GOOD.split('@')[1],
        actual_image_id: IMAGE_ID,
        actual_platform: 'linux/amd64',
        verdict: 'match',
      });
    }
    for (const st of lines.filter((l) => l.event === 'start'))
      expect(st).toMatchObject({
        approved_commit: COMMIT,
        approved_digest: GOOD.split('@')[1],
        approved_platform: 'linux/amd64',
      });
    // the containers were run under a name (not --rm) so they could be inspected, then removed
    expect(calls(s)).not.toMatch(/ run --rm/);
    expect(calls(s)).toMatch(/rm -f kayas-ops-/);
    expect(existsSync(path.join(s.root, 'containers/' + ends[0]!.container))).toBe(false);
    // private, and holding no secret of the env files
    const dir = path.join(s.root, '.training-evidence');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'ops-executions.jsonl')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, 'ops-executions.jsonl'), 'utf8')).not.toMatch(
      /must-never-be-recorded|SECRET|password/i,
    );
  });

  it('a container that ran ANOTHER image than the approved digest is recorded as MISMATCH and the script fails (3), whatever the job did', () => {
    const s = sandbox();
    const r = run(s, ['db-migrate'], { STUB_ACTUAL_IMAGE: OTHER });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/MISMATCH/);
    const end = evidence(s).find((l) => l.event === 'end')!;
    expect(end).toMatchObject({ verdict: 'MISMATCH', actual_digest: OTHER.split('@')[1] });
  });

  it('a platform that is not the approved one is a MISMATCH too', () => {
    const s = sandbox({ platform: 'linux/arm64' });
    const r = run(s, ['db-migrate'], { STUB_PLATFORM: 'linux/amd64' });
    expect(r.status).toBe(3);
    expect(evidence(s).find((l) => l.event === 'end')).toMatchObject({
      verdict: 'MISMATCH',
      actual_platform: 'linux/amd64',
    });
  });

  it('a failing job keeps its own exit code AND its evidence', () => {
    const s = sandbox();
    const r = run(s, ['seed-training'], { STUB_RUN_RC: '7' });
    expect(r.status).toBe(7);
    expect(evidence(s).find((l) => l.event === 'end')).toMatchObject({ exit: '7', verdict: 'match' });
  });

  it('a container that cannot be inspected is "unproven", not assumed fine', () => {
    const s = sandbox();
    const r = run(s, ['db-bootstrap'], { STUB_INSPECT_FAIL: '1' });
    expect(r.status).toBe(3);
    expect(evidence(s).find((l) => l.event === 'end')).toMatchObject({ verdict: 'unproven' });
  });

  it('when the evidence cannot be written the job is NOT run', () => {
    const s = sandbox();
    mkdirSync(path.join(s.root, '.training-evidence'));
    symlinkSync('/dev/null', path.join(s.root, '.training-evidence/ops-executions.jsonl'));
    const r = run(s, ['db-migrate']);
    expect(r.status).not.toBe(0);
    expect(calls(s)).not.toMatch(/ run /);
  });

  it('training-up.sh starts no ops container except through ops.sh (the root job included)', () => {
    const up = readFileSync('scripts/training-up.sh', 'utf8');
    expect(up).not.toMatch(/\$dc run/);
    expect(up).toMatch(/\$ops --prepare-out/);
    expect(readFileSync('scripts/training/ops.sh', 'utf8')).not.toMatch(/run --rm/);
  });
});

describe('R18-11: the approved commit and platform are recorded next to the digest', () => {
  const init = (env: Record<string, string>) => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-init-'));
    mkdirSync(path.join(root, 'scripts/training'), { recursive: true });
    for (const f of ['image-policy.sh', 'init-env.sh'])
      copyFileSync(`scripts/training/${f}`, path.join(root, 'scripts/training', f));
    const r = spawnSync('bash', [path.join(root, 'scripts/training/init-env.sh')], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { r, root };
  };
  it('init-env.sh writes APP_COMMIT and APP_PLATFORM, refuses a malformed commit or an unknown platform', () => {
    const ok = init({ APP_IMAGE: GOOD, APP_COMMIT: COMMIT });
    expect(ok.r.status, ok.r.stderr).toBe(0);
    const text = readFileSync(path.join(ok.root, '.env.training'), 'utf8');
    expect(text).toMatch(new RegExp(`^APP_COMMIT=${COMMIT}$`, 'm'));
    expect(text).toMatch(/^APP_PLATFORM=linux\/amd64$/m);
    expect(init({ APP_IMAGE: GOOD, APP_COMMIT: 'not-a-commit' }).r.status).toBe(1);
    expect(init({ APP_IMAGE: GOOD, APP_COMMIT: COMMIT.slice(1) }).r.status).toBe(1);
    expect(init({ APP_IMAGE: GOOD, APP_PLATFORM: 'windows/amd64' }).r.status).toBe(1);
  });
});
