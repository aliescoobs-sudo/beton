import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 }); // each test drives real shell scripts through several scenarios
import { approvedText, IMG_A, IMG_B, makeSandbox, OWNER, prodConfig, sha } from './ops-sandbox';

// T10g group B (R19B-02, R19B-08): every privileged action is bound to the approved release (commit + digest + platform + run id). The real shell scripts are
// driven in a throwaway git repository with a real origin; docker and curl are stubs that record their calls. A refusal must happen BEFORE any docker
// call that could give a credential to a container: the tests assert on the recorded calls.
const procEnv = (s: { bin: string; root: string }, extra: Record<string, string> = {}) =>
  ({
    PATH: `${s.bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
    HOME: s.root,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@x',
    READY_TRIES: '2',
    READY_SLEEP: '0',
    ...extra,
  }) as unknown as NodeJS.ProcessEnv;
const hasPython = spawnSync('python3', ['--version']).status === 0;
const dc = 'scripts/ops/dc.sh';
const noContainerCalls = (calls: string[]) =>
  calls.filter((c) => / (run|up|exec|create) /.test(` ${c}`) && !/config --format json/.test(c));

describe.skipIf(!hasPython)('scripts/ops/dc.sh binds every command to the approved release', () => {
  it('passes the approved digest explicitly and validates the effective configuration first', () => {
    const s = makeSandbox();
    const r = s.run(dc, ['ps']);
    expect(r.status).toBe(0);
    const calls = s.calls();
    expect(calls[0]).toContain('config --format json');
    expect(calls[calls.length - 1]).toContain(`APP_IMAGE=${IMG_A}`);
    expect(calls[calls.length - 1]).toMatch(
      /compose -f docker-compose\.prod\.yml --env-file \.env\.ops\.prod ps/,
    );
  });
  const shellOverrides: Record<string, Record<string, string>> = {
    'a hostile image in the shell': { APP_IMAGE: 'evil.example/shell:latest' },
    'a good digest in the shell (still not the approved path)': { APP_IMAGE: IMG_B },
    COMPOSE_FILE: { COMPOSE_FILE: 'evil.yml' },
    COMPOSE_PROJECT_NAME: { COMPOSE_PROJECT_NAME: 'other' },
    COMPOSE_PROFILES: { COMPOSE_PROFILES: 'debug' },
    DOCKER_HOST: { DOCKER_HOST: 'tcp://203.0.113.9:2375' },
    DOCKER_CONTEXT: { DOCKER_CONTEXT: 'remote' },
  };
  for (const [name, env] of Object.entries(shellOverrides)) {
    it(`refuses ${name} before any docker call`, () => {
      const s = makeSandbox();
      const r = s.run(dc, ['run', '--rm', 'ops', 'true'], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/is set in the shell/);
      expect(s.called()).toBe('');
    });
  }
  it('refuses an APP_IMAGE (or COMPOSE_*) line in any env file, duplicated or not', () => {
    for (const file of ['.env.prod', '.env.ops.prod', '.env.backup.prod']) {
      const s = makeSandbox();
      s.write(file, `${s.read(file)}APP_IMAGE=${IMG_B}\n`);
      const r = s.run(dc, ['run', '--rm', 'ops', 'true']);
      expect(r.status, file).toBe(1);
      expect(r.stderr, file).toMatch(/sets APP_IMAGE/);
      expect(s.called(), file).toBe('');
    }
    const s = makeSandbox();
    s.write('.env.ops.prod', `${s.read('.env.ops.prod')}COMPOSE_FILE=evil.yml\n`);
    expect(s.run(dc, ['ps']).stderr).toMatch(/sets APP_IMAGE or a COMPOSE_/);
    const link = makeSandbox();
    rmSync(path.join(link.root, '.env.backup.prod'));
    symlinkSync('.env.prod', path.join(link.root, '.env.backup.prod'));
    expect(link.run(dc, ['ps']).stderr).toMatch(/symbolic link/);
  });
  const badApprovals: [string, (commit: string) => string, RegExp][] = [
    [
      'a mutable tag',
      (c) => `COMMIT=${c}\nIMAGE=ghcr.io/${OWNER}/kayas:latest\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /refused image reference/,
    ],
    [
      'a tag with a digest',
      (c) =>
        `COMMIT=${c}\nIMAGE=ghcr.io/${OWNER}/kayas:v1@sha256:${sha('a1')}\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /refused image reference/,
    ],
    [
      'another registry',
      (c) =>
        `COMMIT=${c}\nIMAGE=docker.io/${OWNER}/kayas@sha256:${sha('a1')}\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /refused image reference/,
    ],
    [
      'another owner',
      (c) =>
        `COMMIT=${c}\nIMAGE=ghcr.io/someone-else/kayas@sha256:${sha('a1')}\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /refused image reference/,
    ],
    [
      'another package',
      (c) =>
        `COMMIT=${c}\nIMAGE=ghcr.io/${OWNER}/other@sha256:${sha('a1')}\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /refused image reference/,
    ],
    [
      'an uppercase digest',
      (c) =>
        `COMMIT=${c}\nIMAGE=ghcr.io/${OWNER}/kayas@sha256:${sha('A1')}\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /refused image reference/,
    ],
    [
      'a short digest',
      (c) => `COMMIT=${c}\nIMAGE=ghcr.io/${OWNER}/kayas@sha256:abcd\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /refused image reference/,
    ],
    [
      'the wrong platform',
      (c) => `COMMIT=${c}\nIMAGE=${IMG_A}\nPLATFORM=linux/arm64\nRUN_ID=1\n`,
      /PLATFORM/,
    ],
    [
      'a repeated key',
      (c) => `COMMIT=${c}\nIMAGE=${IMG_A}\nIMAGE=${IMG_B}\nPLATFORM=linux/amd64\nRUN_ID=1\n`,
      /repeats IMAGE/,
    ],
    [
      'an unknown key',
      (c) => `COMMIT=${c}\nIMAGE=${IMG_A}\nPLATFORM=linux/amd64\nRUN_ID=1\nEXTRA=1\n`,
      /unknown key/,
    ],
    [
      'a command substitution',
      (c) => `COMMIT=${c}\nIMAGE=${IMG_A}\nPLATFORM=linux/amd64\nRUN_ID=$(touch pwned)\n`,
      /not KEY=value|RUN_ID/,
    ],
    ['a bad commit', () => `COMMIT=abc123\nIMAGE=${IMG_A}\nPLATFORM=linux/amd64\nRUN_ID=1\n`, /COMMIT/],
    ['a missing run id', (c) => `COMMIT=${c}\nIMAGE=${IMG_A}\nPLATFORM=linux/amd64\n`, /RUN_ID/],
  ];
  for (const [name, body, re] of badApprovals) {
    it(`refuses an approval with ${name}, before any docker call`, () => {
      const s = makeSandbox();
      s.write('release/APPROVED', body(s.head), 0o640);
      const r = s.run(dc, ['run', '--rm', 'ops', 'true']);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(re);
      expect(s.called()).toBe('');
      expect(existsSync(path.join(s.root, 'pwned'))).toBe(false);
    });
  }
  it('refuses without an approval, with an approval that is a link, and with host files at another commit or edited', () => {
    const none = makeSandbox({ approved: false });
    expect(none.run(dc, ['ps']).stderr).toMatch(/Approve a release first/);
    expect(none.called()).toBe('');
    const linked = makeSandbox();
    rmSync(path.join(linked.root, 'release/APPROVED'));
    writeFileSync(path.join(linked.root, 'release/real'), approvedText(linked.head));
    symlinkSync('real', path.join(linked.root, 'release/APPROVED'));
    expect(linked.run(dc, ['ps']).stderr).toMatch(/missing \(or a link\)/);
    const moved = makeSandbox();
    moved.commit('NOTES.md', 'a later commit\n'); // HEAD moves on, the approval stays at the old commit
    const r = moved.run(dc, ['run', '--rm', 'ops', 'true']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/host files are at .*, the approved release is/);
    expect(moved.called()).toBe('');
    const edited = makeSandbox();
    writeFileSync(
      path.join(edited.root, 'scripts/ops/ops.sh'),
      `${readFileSync(path.join(edited.root, 'scripts/ops/ops.sh'), 'utf8')}\n# edited on the host\n`,
    );
    const e = edited.run(dc, ['ps']);
    expect(e.status).toBe(1);
    expect(e.stderr).toMatch(/tracked file differs/);
    expect(edited.called()).toBe('');
  });
  it('refuses a resolved configuration whose image, ports, mounts or flags are not the expected ones, before anything is created', () => {
    const mutate: [string, (c: ReturnType<typeof prodConfig>) => void][] = [
      ['ops on another image', (c) => (c.services.ops.image = IMG_B)],
      ['backup on a tag', (c) => (c.services.backup.image = `ghcr.io/${OWNER}/kayas:latest`)],
      ['bootstrap on another image', (c) => (c.services.bootstrap.image = 'busybox')],
      ['app on another image', (c) => (c.services.app.image = IMG_B)],
      [
        'the database published',
        (c) =>
          (c.services.db.ports = [{ target: 5432, published: '5432', protocol: 'tcp', host_ip: '0.0.0.0' }]),
      ],
      [
        'a mount of the host root into ops',
        (c) => c.services.ops.volumes?.push({ type: 'bind', source: '/', target: '/host', read_only: false }),
      ],
      ['simulation on for the app', (c) => (c.services.app.environment.SIMULATION_ENABLED = 'true')],
      ['training mode in a production service', (c) => (c.services.app.environment.TRAINING_MODE = 'true')],
    ];
    for (const [name, m] of mutate) {
      const cfg = prodConfig();
      m(cfg);
      const s = makeSandbox({ config: cfg });
      const r = s.run(dc, ['run', '--rm', '-T', 'ops', 'true']);
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(/REFUSED/);
      expect(noContainerCalls(s.calls()), name).toEqual([]);
    }
  });
  it('allow-lists the sub-command and the options of run/exec; down never deletes volumes', () => {
    const s = makeSandbox();
    for (const args of [
      ['-f', 'x.yml', 'ps'],
      ['--env-file', 'x', 'ps'],
      ['rm', '-f'],
      ['cp', 'a', 'b'],
      ['run', '-v', '/:/host', 'ops'],
      ['run', '-e', 'X=1', 'ops'],
      ['run', '--entrypoint', 'sh', 'ops'],
      ['run', '--privileged', 'ops'],
      ['run', '--user', 'root', 'ops'],
      ['run', '--cap-add', 'CHOWN', 'ops'],
      ['run', '--rm', 'app'],
      ['exec', '-u', 'root', 'app', 'sh'],
      ['down', '-v'],
      ['down', '--volumes'],
    ])
      expect(s.run(dc, args).status, args.join(' ')).toBe(1);
    expect(noContainerCalls(s.calls())).toEqual([]);
    expect(s.run(dc, ['run', '--rm', '-T', 'ops', 'node', '-v']).status).toBe(0); // "-v" after the service name is the command's own
  });
});

describe.skipIf(!hasPython)('privileged jobs: ops.sh, bootstrap.sh, backup-nightly.sh', () => {
  it('ops.sh runs the job under the approved digest and records commit, digest and the ACTUAL image id (no secret)', () => {
    const s = makeSandbox();
    const r = s.run('scripts/ops/ops.sh', ['--batch', 'db-migrate']);
    expect(r.status, r.stderr).toBe(0);
    const ev = s
      .read('release/evidence/jobs.jsonl')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      event: 'start',
      job: 'db-migrate',
      approved_commit: s.head,
      approved_digest: IMG_A.split('@')[1],
    });
    expect(ev[1]).toMatchObject({
      event: 'end',
      job: 'db-migrate',
      actual_digest: IMG_A.split('@')[1],
      actual_image_id: 'sha256:stubimageid',
      verdict: 'match',
      exit: '0',
    });
    expect(statSync(path.join(s.root, 'release/evidence/jobs.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(s.root, 'release/evidence')).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(ev) + r.stdout + r.stderr).not.toMatch(/canary/);
    const run = s.calls().find((c) => / run --name kayas-job-/.test(c));
    expect(run).toMatch(/ -T ops node --import \.\/scripts\/register-ts-paths\.mjs scripts\/db-migrate\.ts/);
    expect(s.calls().some((c) => /rm -f kayas-job-/.test(c))).toBe(true);
  });
  it('a container that ran another image, or that cannot be inspected, makes the job fail (exit 3) and says MISMATCH / unproven', () => {
    const s = makeSandbox();
    const r = s.run('scripts/ops/ops.sh', ['--batch', 'db-migrate'], { DOCKER_STUB_ACTUAL_IMAGE: IMG_B });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/MISMATCH/);
    expect(s.read('release/evidence/jobs.jsonl')).toMatch(/"verdict":"MISMATCH"/);
    const u = makeSandbox();
    u.failOn('Config.Image');
    expect(u.run('scripts/ops/ops.sh', ['--batch', 'db-migrate']).status).toBe(3);
    expect(u.read('release/evidence/jobs.jsonl')).toMatch(/"verdict":"unproven"/);
  });
  it('a job that fails keeps its own exit code; hostile script names are refused', () => {
    const s = makeSandbox();
    s.failOn('db-migrate.ts');
    expect(s.run('scripts/ops/ops.sh', ['--batch', 'db-migrate']).status).toBe(1);
    for (const bad of ['../x', 'a b', 'A', '-x', 'x;y', ''])
      expect(makeSandbox().run('scripts/ops/ops.sh', ['--batch', bad]).status, bad).not.toBe(0);
  });
  it('ops.sh, bootstrap.sh and backup-nightly.sh refuse a hostile image, an edited host and a moved host before any container exists', () => {
    for (const [script, args] of [
      ['scripts/ops/ops.sh', ['--batch', 'db-migrate']],
      ['scripts/ops/backup-nightly.sh', []],
    ] as const) {
      const env = makeSandbox();
      expect(env.run(script, [...args], { APP_IMAGE: 'evil:latest' }).status, script).not.toBe(0);
      expect(env.called(), script).toBe('');
      const moved = makeSandbox();
      moved.commit('NOTES.md', 'x\n');
      expect(moved.run(script, [...args]).status, script).not.toBe(0);
      expect(moved.called(), script).toBe('');
      const tag = makeSandbox();
      tag.write('release/APPROVED', approvedText(tag.head, `ghcr.io/${OWNER}/kayas:latest`), 0o640);
      expect(tag.run(script, [...args]).status, script).not.toBe(0);
      expect(tag.called(), script).toBe('');
    }
    const b = makeSandbox();
    b.write('.env.bootstrap.prod', 'DATABASE_URL_BACKUP=postgres://b:canary@db/x\n');
    expect(b.run('scripts/ops/bootstrap.sh', [], { APP_IMAGE: 'evil:latest' }).status).not.toBe(0);
    b.write('release/APPROVED', approvedText(b.head, `ghcr.io/${OWNER}/kayas:latest`), 0o640);
    expect(b.run('scripts/ops/bootstrap.sh').status).not.toBe(0);
    expect(b.called()).toBe('');
    expect(existsSync(path.join(b.root, '.env.bootstrap.prod'))).toBe(true); // a refusal keeps the file for the retry
  });
  it('bootstrap.sh: runs the bootstrap service once under the approved digest and deletes the file only on success; refuses any other variable', () => {
    const ok = makeSandbox();
    ok.write('.env.bootstrap.prod', 'DATABASE_URL_BACKUP=postgres://b:canary@db:5432/x\n');
    const r = ok.run('scripts/ops/bootstrap.sh');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(ok.root, '.env.bootstrap.prod'))).toBe(false);
    expect(ok.calls().filter((c) => / run --name /.test(c))).toHaveLength(1);
    expect(ok.calls().find((c) => / run --name /.test(c))).toMatch(/ -T bootstrap node .*db-bootstrap\.ts/);
    const failing = makeSandbox();
    failing.write('.env.bootstrap.prod', 'DATABASE_URL_BACKUP=postgres://b:canary@db:5432/x\n');
    failing.failOn('db-bootstrap.ts');
    expect(failing.run('scripts/ops/bootstrap.sh').status).not.toBe(0);
    expect(existsSync(path.join(failing.root, '.env.bootstrap.prod'))).toBe(true);
    for (const content of ['DATABASE_URL_BACKUP=postgres://b@db/x\nAUTH_SECRET=oops\n', '# nothing\n']) {
      const s = makeSandbox();
      s.write('.env.bootstrap.prod', content);
      expect(s.run('scripts/ops/bootstrap.sh').status, content).not.toBe(0);
      expect(s.called(), content).toBe('');
    }
    expect(makeSandbox().run('scripts/ops/bootstrap.sh').status).not.toBe(0);
  });
  it('backup-nightly.sh runs backup and verification as recorded jobs of the approved image', () => {
    const s = makeSandbox();
    s.write('backups/a.audit-anchor.json', '{}');
    const r = s.run('scripts/ops/backup-nightly.sh');
    expect(r.status, r.stderr).toBe(0);
    const runs = s.calls().filter((c) => / run --name /.test(c));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatch(/ -T backup node .*backup\.ts/);
    expect(runs[1]).toMatch(/ -T backup node .*backup-verify\.ts check/);
    expect(s.read('release/evidence/jobs.jsonl')).toMatch(/"job":"backup-verify"/);
  });
});

describe('approve-release.sh', () => {
  it('writes the four values, refuses bad shapes, unknown commits and a silent replacement', () => {
    const s = makeSandbox({ approved: false });
    const a = ['scripts/ops/approve-release.sh'] as const;
    expect(s.run(a[0], [s.head, IMG_A, 'linux/amd64', '77']).status).toBe(0);
    expect(s.read('release/APPROVED')).toBe(
      `# KAYAS approved release. Written by scripts/ops/approve-release.sh; do not edit.\nCOMMIT=${s.head}\nIMAGE=${IMG_A}\nPLATFORM=linux/amd64\nRUN_ID=77\n`,
    );
    expect(s.run(a[0], [s.head, IMG_B, 'linux/amd64', '78']).stderr).toMatch(/exists; pass --replace/);
    expect(s.run(a[0], [s.head, IMG_B, 'linux/amd64', '78', '--replace']).status).toBe(0);
    expect(s.read('release/APPROVED')).toContain(IMG_B);
    for (const bad of [
      ['abc', IMG_A, 'linux/amd64', '1'],
      [s.head, 'ghcr.io/x/y:tag', 'linux/amd64', '1'],
      [s.head, IMG_A, 'linux/arm64', '1'],
      [s.head, IMG_A, 'linux/amd64', 'x1'],
      ['f'.repeat(40), IMG_A, 'linux/amd64', '1', '--replace'],
    ])
      expect(s.run(a[0], bad).status, bad.join(' ')).not.toBe(0);
    expect(s.run(a[0], [s.head, IMG_A, 'linux/amd64', '1'], { APP_IMAGE: 'x' }).status).not.toBe(0);
  });
});

// ---- deploy: lock, journal, exact checkout, verified rollback
describe.skipIf(!hasPython)('scripts/ops/deploy.sh', () => {
  const deployArgs = (commit: string, image = IMG_B) => [commit, image, 'linux/amd64', '999'];
  const withNewCommit = (o: Parameters<typeof makeSandbox>[0] = {}) => {
    const s = makeSandbox({ ...o });
    s.write('backups/a.audit-anchor.json', '{}');
    const next = s.commit('NOTES.md', 'the new release\n');
    s.git('checkout', '--detach', '-q', s.head); // the host is still at the approved (old) commit
    return { s, next };
  };
  const journal = (s: ReturnType<typeof makeSandbox>) =>
    s
      .read('release/.deploy-journal')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { state: string }).state);

  it('moves the host to the exact commit, pulls the digest, takes the backup first, migrates, starts and writes the new approval and a journal that ends on done', () => {
    const { s, next } = withNewCommit();
    const r = s.run('scripts/ops/deploy.sh', deployArgs(next));
    expect(r.status, r.stderr).toBe(0);
    expect(s.git('rev-parse', 'HEAD')).toBe(next);
    expect(s.read('release/APPROVED')).toContain(`COMMIT=${next}`);
    expect(s.read('release/APPROVED')).toContain(IMG_B);
    expect(s.read('release/APPROVED.previous')).toContain(IMG_A);
    expect(journal(s)).toEqual([
      'begin',
      'pulled',
      'backup_ok',
      'switched',
      'migrated',
      'started',
      'ready',
      'done',
    ]);
    const calls = s.calls().join('\n');
    expect(calls.indexOf(`pull ${IMG_B}`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`pull ${IMG_B}`)).toBeLessThan(calls.indexOf('backup.ts'));
    expect(calls.indexOf('backup.ts')).toBeLessThan(calls.indexOf('db-migrate.ts'));
    expect(calls.indexOf('db-migrate.ts')).toBeLessThan(calls.indexOf('up -d app proxy'));
    // migrations ran with the NEW digest
    expect(s.calls().find((c) => /db-migrate\.ts/.test(c))).toContain(`APP_IMAGE=${IMG_B}`);
    expect(s.calls().find((c) => /backup\.ts/.test(c))).toContain(`APP_IMAGE=${IMG_A}`); // the backup used the CURRENT release
    expect(r.stdout + r.stderr).toMatch(/app ready and public route answers/);
  });
  it('never uses an unqualified git pull and refuses a commit that is unknown, or not part of origin/main', () => {
    for (const f of ['deploy.sh', 'deploy-stage.sh', 'deploy-run.sh'])
      expect(readFileSync(`scripts/ops/${f}`, 'utf8')).not.toMatch(/git pull/);
    const { s } = withNewCommit();
    expect(s.run('scripts/ops/deploy.sh', deployArgs('e'.repeat(40))).stderr).toMatch(/not in the origin/);
    writeFileSync(path.join(s.root, 'x.txt'), 'not on main');
    s.git('checkout', '-q', '-b', 'side');
    s.git('add', '-A');
    s.git('commit', '-qm', 'side');
    const side = s.git('rev-parse', 'HEAD');
    s.git('push', '-q', 'origin', 'side');
    s.git('checkout', '--detach', '-q', s.head);
    const r = s.run('scripts/ops/deploy.sh', deployArgs(side));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not part of origin\/main/);
    expect(s.read('release/APPROVED')).toContain(IMG_A);
  });
  it('refuses a mismatched or hostile release request before pulling anything', () => {
    const { s, next } = withNewCommit();
    for (const args of [
      [next, `ghcr.io/${OWNER}/kayas:latest`, 'linux/amd64', '9'],
      [next, 'docker.io/x/kayas@sha256:' + sha('a1'), 'linux/amd64', '9'],
      [next, IMG_B, 'linux/arm64', '9'],
      [next, IMG_B, 'linux/amd64', 'x'],
      ['abc', IMG_B, 'linux/amd64', '9'],
    ])
      expect(s.run('scripts/ops/deploy.sh', args).status, args.join(' ')).toBe(2);
    expect(s.run('scripts/ops/deploy.sh', deployArgs(next), { APP_IMAGE: IMG_B }).status).not.toBe(0);
    expect(s.calls().filter((c) => /^pull /.test(c))).toEqual([]);
    // the host itself edited: refused
    writeFileSync(path.join(s.root, 'scripts/ops/ops.sh'), '#!/bin/sh\necho edited\n');
    expect(s.run('scripts/ops/deploy.sh', deployArgs(next)).stderr).toMatch(/tracked file differs/);
    expect(s.calls().filter((c) => /^pull /.test(c))).toEqual([]);
  });
  it('a failure before the switch (pull, platform, backup) changes nothing: the approval and the checkout stay, and no rollback is claimed', () => {
    for (const how of ['pull', 'platform', 'backup'] as const) {
      const { s, next } = withNewCommit();
      if (how === 'pull') s.failOn(`pull ${IMG_B}`);
      if (how === 'backup') s.failOn('backup.ts');
      const r = s.run(
        'scripts/ops/deploy.sh',
        deployArgs(next),
        how === 'platform' ? { DOCKER_STUB_PLATFORM: 'linux/arm64' } : {},
      );
      expect(r.status, how).toBe(1);
      expect(r.stderr, how).toMatch(/Nothing was switched/);
      expect(r.stderr, how).not.toMatch(/rolled back/);
      expect(s.read('release/APPROVED'), how).toContain(IMG_A);
      expect(s.git('rev-parse', 'HEAD'), how).toBe(s.head);
      expect(journal(s).at(-1), how).toBe('failed_before_switch');
    }
  });
  it('a failure after the switch puts the previous release back and says "rolled back" ONLY after the old app is ready and the public route answers', () => {
    for (const how of ['migrate', 'start', 'not-ready', 'public-down'] as const) {
      const { s, next } = withNewCommit();
      if (how === 'migrate') s.failOn('db-migrate.ts');
      if (how === 'not-ready') s.notReadyWhile(IMG_B);
      if (how === 'public-down') s.publicDownWhile(IMG_B);
      if (how === 'start') {
        // a start that fails only for the new image (the next test covers a start that fails for the old one too)
        s.write(
          'bin/docker',
          readFileSync(path.join(s.root, 'bin/docker'), 'utf8').replace(
            'exit 0\n',
            `case "$*" in *"up -d app proxy"*) if grep -q ${sha('b2')} "${s.root}/release/APPROVED"; then exit 1; fi;; esac\nexit 0\n`,
          ),
          0o755,
        );
      }
      const r = s.run('scripts/ops/deploy.sh', deployArgs(next));
      expect(r.status, how).toBe(1);
      expect(r.stderr, how).toMatch(
        /rolled back to .* and VERIFIED: the app is ready and the public route answers/,
      );
      expect(s.read('release/APPROVED'), how).toContain(IMG_A);
      expect(s.git('rev-parse', 'HEAD'), how).toBe(s.head);
      expect(journal(s).slice(-3), how).toEqual(
        expect.arrayContaining(['rollback_started', 'rollback_verified']),
      );
      expect(journal(s).at(-1), how).toBe('rollback_verified');
    }
  });
  it('reports RECOVERY FAILED (exit 4, never "rolled back") when the old release does not start, is not ready, or the public route stays down', () => {
    const cases: [string, (s: ReturnType<typeof makeSandbox>) => void][] = [
      ['the old start fails too', (s) => s.failOn('up -d app proxy')],
      [
        'the old release is not ready either',
        (s) => {
          s.notReadyWhile('PLATFORM');
        },
      ],
      [
        'the public route stays down',
        (s) => {
          s.publicDownWhile('PLATFORM');
        },
      ],
    ];
    for (const [name, setup] of cases) {
      const { s, next } = withNewCommit();
      setup(s);
      s.failOn('db-migrate.ts'); // the new release fails first; then the recovery itself fails in the way the case names
      const r = s.run('scripts/ops/deploy.sh', deployArgs(next));
      expect(r.status, name).toBe(4);
      expect(r.stderr, name).toMatch(/RECOVERY FAILED/);
      expect(r.stderr + r.stdout, name).not.toMatch(/rolled back/);
      expect(journal(s).at(-1), name).toBe('ROLLBACK_FAILED');
    }
  }, 30_000);
  it('with no previous release a failure says so and exits 4: it does not invent a rollback', () => {
    const s = makeSandbox({ approved: false });
    s.write('backups/a.audit-anchor.json', '{}');
    s.write('release/APPROVED', approvedText(s.head), 0o640);
    const next = s.commit('NOTES.md', 'x\n');
    s.git('checkout', '--detach', '-q', s.head);
    rmSync(path.join(s.root, 'release/APPROVED'));
    s.run('scripts/ops/approve-release.sh', [s.head, IMG_A, 'linux/amd64', '1']);
    s.failOn('db-migrate.ts');
    const r = s.run('scripts/ops/deploy.sh', deployArgs(next));
    // this host has a previous release (the approval just made), so the rollback is verified; remove it and try the true first install
    expect(r.status).toBe(1);
    const first = makeSandbox({ approved: false });
    first.write('backups/a.audit-anchor.json', '{}');
    const c2 = first.commit('NOTES.md', 'y\n');
    first.git('checkout', '--detach', '-q', first.head);
    first.failOn('db-migrate.ts');
    const r2 = first.run('scripts/ops/deploy.sh', deployArgs(c2));
    expect(r2.status).toBe(4);
    expect(r2.stderr).toMatch(/RECOVERY FAILED: there was no previous release/);
    expect(r2.stderr).not.toMatch(/rolled back/);
  });
  it('one deployment at a time: a second deploy while the lock is held is refused with exit 75', () => {
    const { s, next } = withNewCommit();
    const holder = spawn(
      'python3',
      ['-I', path.join(s.root, 'scripts/ops/with-lock.py'), 'release/.deploy.lock', '--', 'sleep', '20'],
      { cwd: s.root },
    );
    try {
      for (let i = 0; i < 50 && !existsSync(path.join(s.root, 'release/.deploy.lock')); i++)
        spawnSync('sleep', ['0.1']);
      spawnSync('sleep', ['0.3']);
      const r = s.run('scripts/ops/deploy.sh', deployArgs(next));
      expect(r.status).toBe(75);
      expect(r.stderr).toMatch(/another run holds/);
      expect(s.calls().filter((c) => /^pull /.test(c))).toEqual([]);
    } finally {
      holder.kill('SIGKILL');
    }
    // the kernel released the lock when the holder died: nothing stale to clean
    spawnSync('sleep', ['0.3']);
    expect(s.run('scripts/ops/deploy.sh', deployArgs(next)).status).toBe(0);
  });
  it('process death mid-deployment leaves a journal that blocks a new deploy until --recover, which rolls back and verifies', () => {
    const { s, next } = withNewCommit();
    s.hangOn('db-migrate.ts');
    const child = spawn('bash', [path.join(s.root, 'scripts/ops/deploy.sh'), ...deployArgs(next)], {
      cwd: s.root,
      detached: true,
      stdio: 'ignore',
      env: procEnv(s),
    });
    for (
      let i = 0;
      i < 100 &&
      !(existsSync(path.join(s.root, 'release/.deploy-journal')) && journal(s).includes('switched'));
      i++
    )
      spawnSync('sleep', ['0.1']);
    expect(journal(s).at(-1)).toBe('switched');
    process.kill(-child.pid!, 'SIGKILL'); // the whole group: the deploy and its hanging child
    spawnSync('sleep', ['0.5']);
    spawnSync('sh', ['-c', 'rm -f hang.*'], { cwd: s.root });
    expect(journal(s).at(-1)).toBe('switched'); // a killed process cannot write its end
    const blocked = s.run('scripts/ops/deploy.sh', deployArgs(next));
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toMatch(/did not finish \(state 'switched'.*--recover/);
    const rec = s.run('scripts/ops/deploy.sh', ['--recover']);
    expect(rec.status, rec.stderr).toBe(1);
    expect(rec.stderr).toMatch(/rolled back to .* and VERIFIED/);
    expect(s.read('release/APPROVED')).toContain(IMG_A);
    expect(s.git('rev-parse', 'HEAD')).toBe(s.head);
    expect(journal(s).at(-1)).toBe('rollback_verified');
    // after a verified recovery a new deployment may start, and --recover with nothing to recover says so
    expect(s.run('scripts/ops/deploy.sh', ['--recover']).stdout).toMatch(/nothing to recover/);
  });
  it('the deploy files it writes are not world-readable, whatever the caller umask', () => {
    const { s, next } = withNewCommit();
    spawnSync('bash', ['-c', `umask 000; exec bash scripts/ops/deploy.sh ${deployArgs(next).join(' ')}`], {
      cwd: s.root,
      env: procEnv(s),
    });
    for (const f of ['release/APPROVED', 'release/.deploy-journal'])
      expect(statSync(path.join(s.root, f)).mode & 0o007, f).toBe(0);
    chmodSync(path.join(s.root, 'release'), 0o755);
  });
});

describe('release workflow (R19B-10: integration gates the published image)', () => {
  const build = readFileSync('.github/workflows/build-image.yml', 'utf8');
  const integration = readFileSync('.github/workflows/integration.yml', 'utf8');
  it('the image job needs both the unit job and the integration workflow of the SAME commit; integration is callable', () => {
    expect(build).toMatch(
      /integration:\s*\n\s*name: Integration tests\s*\n\s*uses: \.\/\.github\/workflows\/integration\.yml/,
    );
    expect(build).toMatch(/image:[\s\S]*?needs: \[checks, integration\]/);
    expect(integration).toMatch(/workflow_call:/);
    expect(build).not.toMatch(/continue-on-error/);
    expect(build).not.toMatch(/if: always\(\)|if: \$\{\{ always\(\) \}\}/);
    expect(integration).not.toMatch(/continue-on-error/);
  });
  it('prints the four values of the approval for exactly this commit', () => {
    expect(build).toMatch(
      /approve-release\.sh \$\{\{ github\.sha \}\} \$\{\{ steps\.meta\.outputs\.name \}\}@\$\{\{ steps\.build\.outputs\.digest \}\} linux\/amd64 \$\{\{ github\.run_id \}\}/,
    );
    expect(build).not.toMatch(/deploy\.sh \$\{\{ steps\.meta\.outputs\.name \}\}@/);
  });
});
