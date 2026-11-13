import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeSandbox } from './ops-sandbox';

// T10g group C: the operator path. Real pseudo-terminals (scripts/pty-driver.py), real shell scripts in a sandbox, a stub docker, a real TCP relay on loopback.
vi.setConfig({ testTimeout: 60_000 });
const hasPython = spawnSync('python3', ['--version']).status === 0;
const inCi = !!process.env.CI; // in CI the suites below must run: a missing tool is a FAILURE, never a silent skip (R21)
it.runIf(inCi)('CI: python3 is available (the shell-script suites must not be skipped silently)', () => {
  expect(hasPython).toBe(true);
});
const CANARY = 'CANARY-Secret-7f3a9c2e-Value'; // 28 characters of letters, digits and dashes

type Step = { expect: string; send: string };
function pty(
  sb: { root: string; bin: string },
  cmd: string[],
  steps: Step[],
  opts: { umask?: string; env?: Record<string, string> } = {},
) {
  const r = spawnSync(
    'python3',
    [
      '-I',
      path.resolve('scripts/pty-driver.py'),
      '--timeout',
      '40',
      ...(opts.umask ? ['--umask', opts.umask] : []),
      '--',
      ...cmd,
    ],
    {
      cwd: sb.root,
      input: JSON.stringify(steps),
      encoding: 'utf8',
      env: {
        PATH: `${sb.bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
        HOME: sb.root,
        ...opts.env,
      } as unknown as NodeJS.ProcessEnv,
    },
  );
  if (r.status !== 0) throw new Error(`pty-driver failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as { transcript: string; status: number; timeout: boolean };
}
const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(!hasPython && !inCi)(
  'R19B-04: secrets are typed at hidden prompts on a real terminal',
  () => {
    const probe = (dir: string) => {
      writeFileSync(
        path.join(dir, 'probe.ts'),
        `import { createPrompt } from '${path.resolve('scripts/prompt.ts')}';
const p = createPrompt();
const email = await p.ask('email: ');
const pw = await p.secret('password: ');
const code = await p.ask('code: ');
console.log('GOT', email, pw.length, code);
p.close();
`,
      );
      return ['node', '--import', path.resolve('scripts/register-ts-paths.mjs'), path.join(dir, 'probe.ts')];
    };
    it('prompt.ts: the secret is not displayed, and is not handed to the next prompt', () => {
      const sb = makeSandbox();
      const out = pty(sb, probe(sb.root), [
        { expect: 'email: ', send: 'owner@example.test\r' },
        { expect: 'password: ', send: `${CANARY}\r` },
        { expect: 'code: ', send: '123456\r' },
      ]);
      expect(out.timeout).toBe(false);
      expect(out.status).toBe(0);
      expect(out.transcript).not.toContain(CANARY);
      expect(out.transcript).toContain(`GOT owner@example.test ${CANARY.length} 123456`);
    });
    it('prompt.ts: with a pipe (batch) the answers come line by line and nothing is echoed back', () => {
      const sb = makeSandbox();
      const r = spawnSync(probe(sb.root)[0]!, probe(sb.root).slice(1), {
        input: `a@b.c\n${CANARY}\n654321\n`,
        encoding: 'utf8',
      });
      expect(r.stdout).not.toContain(CANARY);
      expect(r.stdout).toContain(`GOT a@b.c ${CANARY.length} 654321`);
    });
    it('every CLI that reads a secret reads it with prompt.secret, never with ask', () => {
      for (const f of [
        'create-owner',
        'reset-owner-2fa',
        'reset-owner-password',
        'import-excel',
        'import-history',
      ]) {
        const src = readFileSync(`scripts/${f}.ts`, 'utf8');
        for (const m of src.matchAll(/\bask\(\s*[`'"]([^`'"]*)[`'"]/g))
          expect(m[1], `${f}: ${m[1]}`).not.toMatch(/password|authenticator|code \(|secret|token|key/i);
      }
    });
    it('make-basic.sh: the password is typed hidden, reaches Caddy on stdin only, and the file is 0644 (the proxy cannot read 0600) under umask 022', () => {
      const sb = makeSandbox({ stack: 'staging' });
      spawnSync('rm', ['-f', path.join(sb.root, 'staging/basic-auth.caddy')]);
      const out = pty(
        sb,
        ['bash', 'scripts/staging/make-basic.sh'],
        [
          { expect: 'user name', send: 'ali-basic\r' },
          { expect: 'Password \\(hidden', send: `${CANARY}\r` },
          { expect: 'Password again', send: `${CANARY}\r` },
        ],
        { umask: '022' },
      );
      expect(out.status, out.transcript).toBe(0);
      expect(out.transcript).not.toContain(CANARY);
      const file = path.join(sb.root, 'staging/basic-auth.caddy');
      expect(mode(file)).toBe(0o644);
      expect(readFileSync(file, 'utf8')).toMatch(
        /basic_auth bcrypt "KAYAS staging" \{\n\tali-basic \$2a\$14\$[./A-Za-z0-9]{53}\n\}/,
      );
      expect(readFileSync(path.join(sb.root, 'stdin.log'), 'utf8')).toBe(`${CANARY}\n`);
      expect(sb.called()).not.toContain(CANARY); // never an argument of docker
      expect(readFileSync(file, 'utf8')).not.toContain(CANARY);
    });
    it('make-basic.sh: refuses without a terminal, refuses a weak or mismatched password, never replaces silently, and batch mode needs the explicit flag', () => {
      const sb = makeSandbox({ stack: 'staging' });
      spawnSync('rm', ['-f', path.join(sb.root, 'staging/basic-auth.caddy')]);
      expect(sb.run('scripts/staging/make-basic.sh', [], {}, 'x\n').stderr).toMatch(/no terminal/);
      const weak = pty(
        sb,
        ['bash', 'scripts/staging/make-basic.sh'],
        [
          { expect: 'user name', send: 'ali-basic\r' },
          { expect: 'Password \\(hidden', send: 'short\r' },
          { expect: 'Password again', send: 'short\r' },
        ],
      );
      expect(weak.status).not.toBe(0);
      expect(existsSync(path.join(sb.root, 'staging/basic-auth.caddy'))).toBe(false);
      const diff = pty(
        sb,
        ['bash', 'scripts/staging/make-basic.sh'],
        [
          { expect: 'user name', send: 'ali-basic\r' },
          { expect: 'Password \\(hidden', send: `${CANARY}\r` },
          { expect: 'Password again', send: `${CANARY}x\r` },
        ],
      );
      expect(diff.status).not.toBe(0);
      expect(diff.transcript).not.toContain(CANARY);
      const batch = sb.run(
        'scripts/staging/make-basic.sh',
        [],
        { KAYAS_BASIC_BATCH: '1' },
        `ali-basic\n${CANARY}\n${CANARY}\n`,
      );
      expect(batch.status, batch.stderr).toBe(0);
      expect(batch.stdout + batch.stderr).not.toContain(CANARY);
      expect(mode(path.join(sb.root, 'staging/basic-auth.caddy'))).toBe(0o644);
      expect(
        sb.run(
          'scripts/staging/make-basic.sh',
          [],
          { KAYAS_BASIC_BATCH: '1' },
          `ali-basic\n${CANARY}\n${CANARY}\n`,
        ).stderr,
      ).toMatch(/already exists/);
    });
    it('bootstrap.sh --create-env: hidden prompt, file created private from the first byte (0600 under umask 022), refused without a terminal', () => {
      const sb = makeSandbox();
      expect(sb.run('scripts/ops/bootstrap.sh', ['--create-env']).stderr).toMatch(/needs a terminal/);
      const out = pty(
        sb,
        ['bash', 'scripts/ops/bootstrap.sh', '--create-env'],
        [{ expect: 'Password of the backup login', send: `${CANARY}\r` }],
        { umask: '022' },
      );
      expect(out.status, out.transcript).toBe(0);
      expect(out.transcript).not.toContain(CANARY);
      const f = path.join(sb.root, '.env.bootstrap.prod');
      expect(mode(f)).toBe(0o600);
      expect(readFileSync(f, 'utf8')).toBe(
        `DATABASE_URL_BACKUP=postgres://belgobeton_backup:${CANARY}@db:5432/belgobeton\n`,
      );
      expect(sb.called()).not.toContain(CANARY);
      // a weak password and an existing file are refused
      const sb2 = makeSandbox();
      expect(
        pty(
          sb2,
          ['bash', 'scripts/ops/bootstrap.sh', '--create-env'],
          [{ expect: 'Password of the backup login', send: 'short\r' }],
        ).status,
      ).not.toBe(0);
      expect(existsSync(path.join(sb2.root, '.env.bootstrap.prod'))).toBe(false);
      expect(sb.run('scripts/ops/bootstrap.sh', ['--create-env']).status).not.toBe(0);
    });
    it('ops.sh: a terminal gives the job a TTY (no -T), a pipe or --batch does not, --interactive without a terminal is refused', () => {
      const sb = makeSandbox();
      const t = pty(sb, ['bash', 'scripts/ops/ops.sh', 'create-owner'], []);
      expect(t.status).toBe(0);
      const tty = sb.calls().find((c) => / run --name /.test(c))!;
      expect(tty).not.toMatch(/ -T /);
      expect(tty).toMatch(/ ops node .*create-owner\.ts/);
      const b = makeSandbox();
      expect(b.run('scripts/ops/ops.sh', ['create-owner'], {}, 'x\n').status).toBe(0);
      expect(b.calls().find((c) => / run --name /.test(c))).toMatch(/ -T ops /);
      const bb = makeSandbox();
      expect(pty(bb, ['bash', 'scripts/ops/ops.sh', '--batch', 'create-owner'], []).status).toBe(0);
      expect(bb.calls().find((c) => / run --name /.test(c))).toMatch(/ -T ops /);
      const i = makeSandbox();
      expect(i.run('scripts/ops/ops.sh', ['--interactive', 'create-owner'], {}, '').stderr).toMatch(
        /needs a terminal/,
      );
      expect(i.called()).toBe('');
    });
    it('init-env.sh: both secret files are 0600 whatever the umask, and nothing is printed', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bb-init-'));
      mkdirSync(path.join(dir, 'scripts/staging'), { recursive: true });
      mkdirSync(path.join(dir, 'scripts/training'), { recursive: true });
      copyFileSync('scripts/staging/init-env.sh', path.join(dir, 'scripts/staging/init-env.sh'));
      copyFileSync('scripts/training/image-policy.sh', path.join(dir, 'scripts/training/image-policy.sh'));
      const r = spawnSync('bash', ['-c', 'umask 022; exec bash scripts/staging/init-env.sh'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          APP_DOMAIN: 'kayas.example.com',
        } as unknown as NodeJS.ProcessEnv,
      });
      expect(r.status, r.stderr).toBe(0);
      for (const f of ['.env.staging', '.env.staging.ops']) expect(mode(path.join(dir, f))).toBe(0o600);
      const env = readFileSync(path.join(dir, '.env.staging'), 'utf8');
      expect(env).toMatch(/^APP_BASE_URL=https:\/\/kayas\.example\.com$/m);
      expect(env).not.toMatch(/APP_IMAGE|ANTHROPIC|VAPID|\$2[aby]\$/);
      expect(r.stdout + r.stderr).not.toMatch(/AUTH_SECRET|postgres:\/\//);
      expect(
        spawnSync('bash', ['scripts/staging/init-env.sh'], {
          cwd: dir,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            APP_DOMAIN: 'kayas.example.com',
          } as unknown as NodeJS.ProcessEnv,
        }).status,
      ).not.toBe(0); // never overwrites
    });
  },
);

// ---------------- R19B-05
describe.skipIf(!hasPython && !inCi)('R19B-05: verify-host.sh fails closed and judges every binding', () => {
  const port = (ip: string, p: string) => ({ HostIp: ip, HostPort: p });
  const container = (
    name: string,
    ports: Record<string, { HostIp: string; HostPort: string }[]>,
    host: Record<string, unknown> = {},
  ) => ({
    Name: `/${name}`,
    Id: name.padEnd(64, '0'),
    HostConfig: { NetworkMode: 'default', ...host },
    NetworkSettings: { Ports: ports },
  });
  const good = [
    container('proxy', {
      '80/tcp': [port('0.0.0.0', '80'), port('::', '80')],
      '443/tcp': [port('0.0.0.0', '443'), port('::', '443')],
    }),
    container('app', { '3000/tcp': null as never }),
    container('db', {}),
  ];
  function host(
    o: {
      inspect?: unknown;
      psFail?: boolean;
      inspectFail?: boolean;
      ss?: string;
      ssFail?: boolean;
      inspectRaw?: string;
    } = {},
  ) {
    const sb = makeSandbox();
    writeFileSync(path.join(sb.root, 'ps.ids'), 'a\nb\nc\n');
    writeFileSync(path.join(sb.root, 'inspect.json'), o.inspectRaw ?? JSON.stringify(o.inspect ?? good));
    if (o.psFail) writeFileSync(path.join(sb.root, 'ps.fail'), '');
    if (o.inspectFail) writeFileSync(path.join(sb.root, 'inspect.fail'), '');
    const stub = (n: string, body: string) => {
      writeFileSync(path.join(sb.bin, n), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(path.join(sb.bin, n), 0o755);
    };
    stub(
      'sshd',
      'printf "passwordauthentication no\\nkbdinteractiveauthentication no\\npermitrootlogin no\\npubkeyauthentication yes\\n"',
    );
    stub(
      'ss',
      o.ssFail
        ? 'exit 1'
        : `printf '%b\\n' ${JSON.stringify(o.ss ?? 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 4096 [::]:443 [::]:*\nLISTEN 0 4096 127.0.0.53:53 0.0.0.0:*')}`,
    );
    stub(
      'stat',
      'case "$*" in *import-work) echo "10001 2770";; *%u*) echo 1000;; *) echo "10001 2750";; esac',
    );
    stub('dpkg', 'exit 0');
    stub('timedatectl', 'echo yes');
    mkdirSync(path.join(sb.root, 'keys'), { recursive: true });
    return { sb, run: () => sb.run('scripts/ops/verify-host.sh') };
  }
  it('passes on the expected host (wildcard 80/443 on IPv4 and IPv6, nothing else)', () => {
    const r = host().run();
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/ok {4}docker publishes only 80 and 443/);
  });
  const bad: [string, Parameters<typeof host>[0], RegExp][] = [
    ['the docker query fails', { psFail: true }, /docker inventory: 'docker ps' failed/],
    ['the inspect query fails', { inspectFail: true }, /'docker inspect' failed or returned nothing/],
    ['the inspect output is garbage', { inspectRaw: 'not json' }, /could not be parsed/],
    [
      'a container publishes a public IP explicitly',
      { inspect: [container('x', { '8080/tcp': [port('203.0.113.5', '8080')] })] },
      /explicit host address 203\.0\.113\.5:8080/,
    ],
    [
      'an allowed port on an explicit public IP',
      { inspect: [container('x', { '443/tcp': [port('203.0.113.5', '443')] })] },
      /explicit host address 203\.0\.113\.5:443/,
    ],
    [
      'one container publishes 80, 443 AND 5432 (the old grep hid it)',
      {
        inspect: [
          container('x', {
            '80/tcp': [port('0.0.0.0', '80')],
            '443/tcp': [port('0.0.0.0', '443')],
            '5432/tcp': [port('0.0.0.0', '5432')],
          }),
        ],
      },
      /5432/,
    ],
    [
      'an IPv6 wildcard on another port',
      { inspect: [container('x', { '3000/tcp': [port('::', '3000')] })] },
      /3000/,
    ],
    ['udp on 443', { inspect: [container('x', { '443/udp': [port('0.0.0.0', '443')] })] }, /443\/udp/],
    [
      'a container on the host network',
      { inspect: [container('x', {}, { NetworkMode: 'host' })] },
      /HOST network/,
    ],
    ['a privileged container', { inspect: [container('x', {}, { Privileged: true })] }, /privileged/],
    [
      'a stray listener on the host',
      { ss: 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*' },
      /unexpected non-loopback listener[\s\S]*5432/,
    ],
    ['ss fails', { ssFail: true }, /'ss' failed/],
  ];
  for (const [name, o, re] of bad) {
    it(`fails when ${name}`, () => {
      const r = host(o).run();
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/FAIL/);
      expect(r.stdout).toMatch(re);
    });
  }
  it('--staging skips the production folders (keys, reports, import-work) and nothing else', () => {
    const h = host();
    const prod = h.sb.run('scripts/ops/verify-host.sh', ['--staging']);
    expect(prod.stdout).not.toMatch(/keys\/|import-work\//);
    expect(prod.stdout).toMatch(/ssh: password authentication off/);
    expect(prod.status).toBe(0);
    const bad = host({ psFail: true }).sb.run('scripts/ops/verify-host.sh', ['--staging']);
    expect(bad.status).toBe(1);
  });
  it('accepts a loopback-only publication and an empty host, and keeps the sshd checks', () => {
    expect(
      host({ inspect: [container('x', { '3000/tcp': [port('127.0.0.1', '3000')] })] }).run().status,
    ).toBe(0);
    const empty = makeSandbox();
    expect(empty.called()).toBe('');
  });
});

// ---------------- R19B-11
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n); // a monotonic clock for waiting only (the lint rule keeps Date and performance out)
function waitPort(portNo: number, up: boolean, ms = 5000): Promise<boolean> {
  const t0 = nowMs();
  return new Promise((resolve) => {
    const again = (giveUp: boolean) => (nowMs() - t0 > ms ? resolve(giveUp) : setTimeout(tryOnce, 100));
    const tryOnce = () => {
      const s = net.connect({ host: '127.0.0.1', port: portNo });
      s.once('connect', () => {
        s.destroy();
        if (up) resolve(true);
        else again(false); // still listening: keep waiting for it to close
      });
      s.once('error', () => {
        if (up)
          again(false); // not yet listening: keep waiting
        else resolve(true); // refused: it is closed
      });
    };
    tryOnce();
  });
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const talk = (portNo: number) =>
  new Promise<string>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: portNo });
    let d = '';
    s.on('data', (b) => (d += b));
    s.on('close', () => resolve(d));
    s.on('error', () => resolve('ERROR'));
    setTimeout(() => {
      s.destroy();
    }, 1500);
  });

describe('R19B-11: the LAN relay is capped and is stopped, verifiably, by the ordinary shutdown', () => {
  it('caps open connections in all and per source, and closes both halves together', async () => {
    const { createRelay } = await import('./training/lan-relay-core.mjs');
    const upstream = net.createServer((c) => c.on('error', () => {}).write('FIXTURE')).listen(0, '127.0.0.1');
    await new Promise((r) => upstream.once('listening', r));
    const up = (upstream.address() as net.AddressInfo).port;
    const relay = createRelay({
      targetPort: up,
      isAllowedSource: () => true,
      maxConnections: 3,
      maxPerSource: 2,
      idleMs: 60_000,
    });
    relay.server.listen(0, '127.0.0.1');
    await new Promise((r) => relay.server.once('listening', r));
    const rp = (relay.server.address() as net.AddressInfo).port;
    const held: net.Socket[] = [];
    const open = () =>
      new Promise<net.Socket>((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port: rp });
        s.on('error', () => {});
        held.push(s);
        s.once('data', () => resolve(s));
        s.once('close', () => resolve(s));
      });
    await open();
    await open();
    expect(relay.openCount()).toBe(2);
    // the third connection from the same source is over the per-source cap: destroyed at once, never forwarded
    const third = net.connect({ host: '127.0.0.1', port: rp });
    third.on('error', () => {});
    held.push(third);
    const closed = await new Promise<boolean>((resolve) => {
      third.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 1500);
    });
    expect(closed).toBe(true);
    expect(relay.stats.refusedLimit).toBe(1);
    expect(relay.openCount()).toBe(2);
    // a closed client frees its slot
    held[0]!.destroy();
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.openCount()).toBe(1);
    expect(await talk(rp)).toBe('FIXTURE');
    // a source that is not allowed is destroyed
    const closedRelay = createRelay({ targetPort: up, isAllowedSource: () => false });
    closedRelay.server.listen(0, '127.0.0.1');
    await new Promise((r) => closedRelay.server.once('listening', r));
    expect(await talk((closedRelay.server.address() as net.AddressInfo).port)).toBe('');
    for (const h of held) h.destroy();
    relay.server.close();
    closedRelay.server.close();
    upstream.close();
  });

  function relaySandbox() {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-relay-'));
    mkdirSync(path.join(dir, 'scripts/training'), { recursive: true });
    copyFileSync('scripts/training/relay-stop.sh', path.join(dir, 'scripts/training/relay-stop.sh'));
    copyFileSync(
      'scripts/training/lan-relay-core.mjs',
      path.join(dir, 'scripts/training/lan-relay-core.mjs'),
    );
    copyFileSync('scripts/training-down.sh', path.join(dir, 'training-down.sh'));
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    copyFileSync('scripts/training-down.sh', path.join(dir, 'scripts/training-down.sh'));
    // a stand-in for the CLI (the real one refuses a loopback address on purpose): same file name, same core, loopback, optionally deaf to TERM
    writeFileSync(
      path.join(dir, 'scripts/training/lan-relay.mjs'),
      `import { createRelay } from './lan-relay-core.mjs';
const [listen, target, deaf] = process.argv.slice(2).map(Number);
if (deaf) process.on('SIGTERM', () => {});
createRelay({ targetPort: target, isAllowedSource: () => true }).server.listen(listen, '127.0.0.1');
`,
    );
    writeFileSync(
      path.join(dir, 'scripts/training/dc.sh'),
      `#!/usr/bin/env bash\necho "dc $*" >> "${dir}/dc.called"\n`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(dir, '.env.training'), 'LAN_BIND_IP=127.0.0.1\n', { mode: 0o600 });
    return dir;
  }
  const startRelay = async (dir: string, listen: number, target: number, deaf = 0): Promise<ChildProcess> => {
    const child = spawn(
      process.execPath,
      [path.join(dir, 'scripts/training/lan-relay.mjs'), String(listen), String(target), String(deaf)],
      { cwd: dir, stdio: 'ignore' },
    );
    writeFileSync(path.join(dir, '.training-lan-relay.pid'), `${child.pid}\n`);
    expect(await waitPort(listen, true)).toBe(true);
    return child;
  };
  const stopScript = (dir: string, listen: number) =>
    spawnSync('bash', [path.join(dir, 'scripts/training/relay-stop.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', LAN_PORT_CHECK: String(listen) } as unknown as NodeJS.ProcessEnv,
    });

  it('stopping normally leaves no process and no listener, and a harmless loopback service is NOT reachable through the old LAN address', async () => {
    const dir = relaySandbox();
    const fixture = net
      .createServer((c) => c.on('error', () => {}).end('LOOPBACK-FIXTURE'))
      .listen(0, '127.0.0.1');
    await new Promise((r) => fixture.once('listening', r));
    const target = (fixture.address() as net.AddressInfo).port;
    const listen = await freePort();
    const child = await startRelay(dir, listen, target);
    expect(await talk(listen)).toBe('LOOPBACK-FIXTURE'); // while the relay runs it forwards
    const r = stopScript(dir, listen);
    expect(r.status, r.stderr).toBe(0);
    await new Promise((res) => setTimeout(res, 300));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(await waitPort(listen, false, 1000)).toBe(true); // refused: nothing listens on the old LAN address any more
    expect(await talk(listen)).toBe('ERROR');
    expect(await talk(target)).toBe('LOOPBACK-FIXTURE'); // the loopback service itself is untouched, but no longer exposed through the relay
    fixture.close();
  });
  it('finds a relay whose pid file was lost, ignores a pid file that names another program, and kills one that ignores TERM', async () => {
    const dir = relaySandbox();
    const fixture = net.createServer((c) => c.on('error', () => {}).end('X')).listen(0, '127.0.0.1');
    await new Promise((r) => fixture.once('listening', r));
    const target = (fixture.address() as net.AddressInfo).port;
    const listen = await freePort();
    const child = await startRelay(dir, listen, target);
    writeFileSync(path.join(dir, '.training-lan-relay.pid'), ''); // lost
    expect(stopScript(dir, listen).status).toBe(0);
    await new Promise((res) => setTimeout(res, 300));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    // a reused pid: the file names a harmless program, which must survive
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeFileSync(path.join(dir, '.training-lan-relay.pid'), `${sleeper.pid}\n`);
    expect(stopScript(dir, await freePort()).status).toBe(0);
    expect(() => process.kill(sleeper.pid!, 0)).not.toThrow();
    sleeper.kill('SIGKILL');
    // deaf to TERM
    const l2 = await freePort();
    const deaf = await startRelay(dir, l2, target, 1);
    const t0 = nowMs();
    expect(stopScript(dir, l2).status).toBe(0);
    expect(nowMs() - t0).toBeGreaterThan(4000);
    await new Promise((res) => setTimeout(res, 300));
    expect(deaf.exitCode !== null || deaf.signalCode !== null).toBe(true);
    fixture.close();
  }, 60_000);
  it('the ordinary shutdown (training-down.sh) stops the relay BEFORE the containers, and lan-down.sh uses the same stop', async () => {
    const dir = relaySandbox();
    const fixture = net.createServer((c) => c.on('error', () => {}).end('X')).listen(0, '127.0.0.1');
    await new Promise((r) => fixture.once('listening', r));
    const target = (fixture.address() as net.AddressInfo).port;
    const listen = await freePort();
    const child = await startRelay(dir, listen, target);
    const r = spawnSync('bash', [path.join(dir, 'scripts/training-down.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', LAN_PORT_CHECK: String(listen) } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status, r.stderr).toBe(0);
    await new Promise((res) => setTimeout(res, 300));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(readFileSync(path.join(dir, 'dc.called'), 'utf8')).toContain('stop-all');
    expect(await talk(listen)).toBe('ERROR');
    fixture.close();
    const down = readFileSync('scripts/training/lan-down.sh', 'utf8');
    expect(down).toMatch(/relay-stop\.sh/);
    expect(readFileSync('scripts/training-down.sh', 'utf8').indexOf('relay-stop.sh')).toBeLessThan(
      readFileSync('scripts/training-down.sh', 'utf8').indexOf('stop-all'),
    );
    expect(readFileSync('docs/training/RESEAU-LOCAL.fr.md', 'utf8')).not.toMatch(
      /chaque téléphone a son propre compteur/,
    );
    expect(readFileSync('docs/training/RESEAU-LOCAL.fr.md', 'utf8')).toMatch(
      /tous les téléphones partagent le même compteur/,
    );
  });
});

// ---------------- R19B-09
describe('R19B-09: the maintenance paths exist and are writable where they must be', () => {
  const prod = readFileSync('docker-compose.prod.yml', 'utf8');
  it('imports/ stays read-only; import-work/ (mapping, reports) is the writable place and .logs is a mount or exists in the image', () => {
    expect(prod).toMatch(/- \.\/imports:\/app\/imports:ro/);
    expect(prod).toMatch(/- \.\/import-work:\/app\/import-work\n/);
    expect(prod).toMatch(/- \.\/import-work\/reports:\/app\/\.logs\n/);
    expect(readFileSync('Dockerfile', 'utf8')).toMatch(
      /mkdir -p \/data\/file-store \/app\/backups \/app\/\.logs/,
    );
    const init = readFileSync('scripts/ops/init-host.sh', 'utf8');
    expect(init).toMatch(
      /install -d -o "\$deployer" -g 10001 -m 2770 "\$root\/import-work" "\$root\/import-work\/mapping" "\$root\/import-work\/reports"/,
    );
    expect(init).toMatch(/install -d -o "\$deployer" -g 10001 -m 2750 "\$root\/imports"/);
  });
  it('the runbook uses the writable mapping folder and the interactive wrapper, and owner recovery is an ordinary ops job', () => {
    const rb = readFileSync('docs/RUNBOOK.md', 'utf8');
    expect(rb).toMatch(/--init-mapping import-work\/mapping/);
    expect(rb).not.toMatch(/--init-mapping imports\/mapping/);
    expect(rb).toMatch(
      /ops\.sh --interactive import-excel --apply imports\/book\.xlsx --mapping import-work\/mapping/,
    );
    expect(rb).not.toMatch(/dc\.sh run --rm ops node/);
    expect(rb).toMatch(/ops\.sh --interactive reset-owner-password/);
    expect(rb).not.toMatch(/user:reset-owner-password/);
  });
});
