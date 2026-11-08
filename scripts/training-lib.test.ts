import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { realClock } from '../src/modules/clock';
import { parsePin } from '../src/modules/field/domain/pin';
import { checkPassword } from '../src/modules/platform-security/auth/password-policy';
import {
  PASSWORD_ACCOUNTS,
  emailOf,
  generatePassword,
  generatePin,
  acquireSeedLock,
  commitCredentialsFile,
  SEED_LOCK_NAME,
  SeedLockError,
  renderCredentialsFile,
  STAGING_NAME,
  stageCredentialsFile,
  sweepStaleStagedCredentials,
  isMountPoint,
  validateCredentialsPath,
} from './training-lib';

describe('training credentials (T1)', () => {
  it('passwords are 16 characters, accepted by the password rule, and different every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(16);
      expect(checkPassword(p).ok).toBe(true);
      expect(p).not.toMatch(/[0OlIi1]/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
  it('PINs are six digits and pass the PIN rules, even when the dice insist on a run', () => {
    let calls = 0;
    const rigged = (max: number) => (calls++ < 6 ? calls % max : (calls * 7) % max); // 1,2,3,4,5,6 first: a run, refused
    const pin = generatePin(rigged);
    expect(pin).toMatch(/^\d{6}$/);
    expect(parsePin(pin).ok).toBe(true);
    for (let i = 0; i < 100; i++) expect(parsePin(generatePin()).ok).toBe(true);
  });
  it('the plan has one account per role, both plant managers, and only reserved training addresses', () => {
    const roles = PASSWORD_ACCOUNTS.map((a) => a.role);
    for (const r of ['owner', 'app_admin', 'office_sales', 'office_purchases', 'accountant'])
      expect(roles.filter((x) => x === r)).toHaveLength(1);
    expect(PASSWORD_ACCOUNTS.filter((a) => a.role === 'plant_manager').map((a) => a.plant)).toEqual([
      'TET',
      'CHF',
    ]);
    for (const a of PASSWORD_ACCOUNTS) expect(emailOf(a.login)).toMatch(/@formation\.kayas\.invalid$/);
  });
  it('the file lists every credential once and says the data are fictitious', () => {
    const text = renderCredentialsFile(
      'https://beton.aliobsil.com',
      [
        {
          label: 'Propriétaire',
          role: 'owner',
          login: 'a@formation.kayas.invalid',
          secret: 'S3cretS3cretS3cr',
          secretKind: 'password',
        },
        { label: 'Chauffeur 1', role: 'driver', login: 'CH-01', secret: '482913', secretKind: 'pin' },
      ],
      new Date('2026-11-04T10:00:00Z'),
    );
    expect(text).toContain('S3cretS3cretS3cr');
    expect(text).toContain('PIN : 482913');
    expect(text).toMatch(/fictives/);
  });
});

describe('the credentials file (R11-04)', () => {
  const dir = (mode = 0o700) => {
    const d = mkdtempSync(path.join(tmpdir(), 'bb-lib-'));
    chmodSync(d, mode);
    return d;
  };
  it('is staged exclusively with mode 0600 and put in place by a rename', () => {
    const d = dir();
    const file = path.join(d, 'training-accounts.local.txt');
    const staged = stageCredentialsFile(file, 'secret\n');
    expect(readdirSync(d)).toHaveLength(1);
    expect(statSync(staged.tmp).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(false);
    commitCredentialsFile(staged);
    expect(readFileSync(file, 'utf8')).toBe('secret\n');
    expect(readdirSync(d)).toEqual(['training-accounts.local.txt']);
  });
  it('replaces an earlier regular file of ours, never a link', () => {
    const d = dir();
    const file = path.join(d, 'training-accounts.local.txt');
    writeFileSync(file, 'old', { mode: 0o600 });
    commitCredentialsFile(stageCredentialsFile(file, 'new'));
    expect(readFileSync(file, 'utf8')).toBe('new');
    const other = path.join(d, 'training-accounts2.local.txt');
    symlinkSync(file, other);
    expect(() => validateCredentialsPath(other)).toThrow(/regular file/);
  });
  it('refuses a foreign name, a shared folder, a missing folder and a folder that is a link', () => {
    expect(() => validateCredentialsPath(path.join(dir(), 'notes.txt'))).toThrow(/ignore rules/);
    expect(() => validateCredentialsPath(path.join(dir(0o777), 'training-accounts.local.txt'))).toThrow(
      /writable/,
    );
    expect(() => validateCredentialsPath(path.join(dir(), 'x', 'training-accounts.local.txt'))).toThrow(
      /folder/,
    );
    const real = dir();
    const link = path.join(dir(), 'link');
    symlinkSync(real, link);
    expect(() => validateCredentialsPath(path.join(link, 'training-accounts.local.txt'))).toThrow(/link/);
  });
  it('accepts the names the ignore rules cover', () => {
    for (const n of ['training-accounts.local.txt', 'training-accounts-owner.local.txt'])
      expect(validateCredentialsPath(path.join(dir(), n))).toMatch(/training-accounts/);
  });
});

describe('R12-02: no secret under an unignored name, nothing left behind, no checkout as output', () => {
  const dir = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'bb-r12-'));
    chmodSync(d, 0o700);
    return d;
  };
  const ignoreRules = (file: string) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
  // a gitignore glob, enough for these patterns: * is any run of characters except a slash
  const covered = (name: string, rules: string[]) =>
    rules.some((r) =>
      new RegExp(`^${r.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(name),
    );

  it('the staging name is covered by .gitignore and .dockerignore, and is not a hidden name', () => {
    const d = dir();
    const staged = stageCredentialsFile(path.join(d, 'training-accounts.local.txt'), 'x');
    const name = path.basename(staged.tmp);
    expect(name).toMatch(STAGING_NAME);
    expect(name.startsWith('.')).toBe(false);
    for (const f of ['.gitignore', '.dockerignore'])
      expect(covered(name, ignoreRules(f)), `${f}: ${name}`).toBe(true);
    // the old hidden staging names are covered too
    for (const f of ['.gitignore', '.dockerignore'])
      expect(covered('.training-accounts.local.txt.0123456789ab', ignoreRules(f))).toBe(true);
    // and a staging name is never accepted as a final destination
    expect(() => validateCredentialsPath(staged.tmp)).toThrow(/ignore rules/);
  });
  it('a rename that fails removes the staged file', () => {
    const d = dir();
    const final = path.join(d, 'training-accounts.local.txt');
    const staged = stageCredentialsFile(final, 'secret');
    mkdirSync(final); // a directory in the way: the rename cannot replace it
    expect(() => commitCredentialsFile(staged)).toThrow();
    expect(readdirSync(d).filter((n) => STAGING_NAME.test(n))).toEqual([]);
  });
  it('the startup sweep removes only stages of a superseded attempt (and old enough), keeps unknown ones and reports them', () => {
    const d = dir();
    const final = path.join(d, 'training-accounts.local.txt');
    writeFileSync(final, 'keep', { mode: 0o600 });
    const other = path.join(d, 'training-accounts.staging-t0123456789ab.local.txt'); // an earlier attempt's own stage
    const young = path.join(d, 'training-accounts.staging-tbbbbbbbbbbbb.local.txt');
    const unknown = path.join(d, 'training-accounts.staging-0123456789ab.local.txt'); // bare name: creator unknown
    const legacy = path.join(d, '.training-accounts.local.txt.abcdef012345');
    writeFileSync(other, 'stale', { mode: 0o600 });
    writeFileSync(young, 'young', { mode: 0o600 });
    writeFileSync(unknown, 'who knows', { mode: 0o600 });
    writeFileSync(legacy, 'who knows', { mode: 0o600 });
    writeFileSync(path.join(d, 'notes.txt'), 'mine');
    symlinkSync('/etc/hosts', path.join(d, 'training-accounts.staging-taaaaaaaaaaaa.local.txt'));
    const old = new Date(realClock.now().getTime() - 3_600_000);
    for (const n of [other, unknown, legacy]) utimesSync(n, old, old);
    const lock = acquireSeedLock(final);
    const r = sweepStaleStagedCredentials(final, lock);
    expect(r.removed).toBe(1);
    expect(r.unknown.sort()).toEqual(
      [
        '.training-accounts.local.txt.abcdef012345',
        'training-accounts.staging-0123456789ab.local.txt',
      ].sort(),
    );
    lock.release();
    expect(existsSync(other)).toBe(false);
    expect(existsSync(young)).toBe(true); // the age gate, on top of the attempt rule
    expect(existsSync(unknown)).toBe(true); // creator unknown: never deleted
    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(final, 'utf8')).toBe('keep');
  });
  describe('R14-12, R15A-05: the seed lock, the takeover and the fence', () => {
    const mk = () => {
      const d = dir();
      return { d, final: path.join(d, 'training-accounts.local.txt') };
    };
    const locks = (d: string) => readdirSync(d).filter((n) => n.startsWith(SEED_LOCK_NAME));
    // a clock the test moves; heartbeats never run on their own (the interval is an hour)
    const clockAt = (t0: number) => {
      const c = { t: t0, now: () => c.t, heartbeatMs: 3_600_000 };
      return c;
    };
    const age = (d: string, file: string, c: { t: number }) =>
      utimesSync(path.join(d, file), new Date(c.t), new Date(c.t));
    it("a second seed is refused while the first one's lock is live, and the lock goes when it is released", () => {
      const { d, final } = mk();
      const a = acquireSeedLock(final);
      expect(() => acquireSeedLock(final)).toThrow(SeedLockError);
      expect(a.held()).toBe(true);
      a.release();
      expect(locks(d)).toEqual([]);
      acquireSeedLock(final).release();
    });
    it('an abandoned lock (no heartbeat) is taken over by the NEXT epoch; a live one never is', () => {
      const { d, final } = mk();
      const c = clockAt(1_000_000);
      const dead = acquireSeedLock(final, c); // its heartbeat never runs in this test
      const first = locks(d);
      expect(first).toEqual([`${SEED_LOCK_NAME}.1`]);
      age(d, first[0]!, c);
      c.t += 30_000;
      expect(() => acquireSeedLock(final, c)).toThrow(SeedLockError); // 30 s: still live
      c.t += 60_000;
      const taker = acquireSeedLock(final, c); // 90 s without a beat: abandoned
      expect(locks(d)).toEqual([`${SEED_LOCK_NAME}.2`]);
      expect(taker.held()).toBe(true);
      expect(dead.held()).toBe(false); // the old holder no longer holds anything...
      expect(() => dead.assertHeld('the marker')).toThrow(/no longer holds the seed lock/);
      dead.release();
      expect(locks(d)).toEqual([`${SEED_LOCK_NAME}.2`]); // ...and its release does not remove the new holder's lock
      taker.release();
      expect(locks(d)).toEqual([]);
    });
    it("concurrent takers of one abandoned lock: exactly one wins, and the winner's NEW lock is never removed by the loser", () => {
      const { d, final } = mk();
      const c = clockAt(5_000_000);
      const dead = acquireSeedLock(final, c);
      age(d, locks(d)[0]!, c);
      c.t += 120_000;
      // B and C have both read "epoch 1 is abandoned". B takes epoch 2 first; C then acts on its stale reading: the epoch it wants exists.
      const b = acquireSeedLock(final, c);
      // C re-reads and finds B's fresh lock...
      expect(() => acquireSeedLock(final, c)).toThrow(/live/);
      // ...and even if C had read before B acted, its exclusive create of the same epoch fails. Simulate by planting C's target ourselves:
      expect(b.held()).toBe(true);
      expect(locks(d)).toEqual([`${SEED_LOCK_NAME}.2`]);
      dead.release();
      expect(b.held()).toBe(true); // nobody removed B's lock
      b.release();
    });
    it('two processes racing for an abandoned lock: one wins, the other is refused, the winner keeps holding', () => {
      const { d, final } = mk();
      // plant an abandoned epoch-7 lock (mtime two hours ago)
      const planted = path.join(d, `${SEED_LOCK_NAME}.7`);
      writeFileSync(planted, JSON.stringify({ token: 'x', epoch: 7 }), { mode: 0o600 });
      const old = new Date(realClock.now().getTime() - 7_200_000);
      utimesSync(planted, old, old);
      const script = `import('./scripts/training-lib.ts').then(async (m) => { try { const l = m.acquireSeedLock(${JSON.stringify(final)}); console.log('won'); await new Promise((r) => setTimeout(r, 400)); console.log(l.held() ? 'still-held' : 'LOST'); l.release(); process.exit(0); } catch (e) { console.log(e instanceof m.SeedLockError ? 'refused' : 'error'); process.exit(0); } })`;
      // start 4 at once through the shell: they all read the same abandoned lock
      const r = spawnSync(
        'sh',
        [
          '-c',
          `for i in 1 2 3 4; do (${JSON.stringify(process.execPath)} --import ./scripts/register-ts-paths.mjs -e ${JSON.stringify(script)} &) ; done; sleep 3`,
        ],
        { encoding: 'utf8' },
      );
      const out = r.stdout.split('\n').filter(Boolean);
      expect(out.filter((x) => x === 'won').length).toBe(1);
      expect(out.filter((x) => x === 'refused').length).toBe(3);
      expect(out).toContain('still-held');
      expect(out).not.toContain('LOST');
      expect(out).not.toContain('error');
    }, 20_000);
    it('a suspended holder that resumes after a takeover is fenced at every commit', () => {
      const { d, final } = mk();
      const c = clockAt(9_000_000);
      const a = acquireSeedLock(final, c);
      const staged = stageCredentialsFile(final, 'password: A\n', a.attempt);
      expect(a.held()).toBe(true);
      // A is suspended: no beat for 90 s of the wall clock; B takes over
      age(d, locks(d)[0]!, c);
      c.t += 90_000;
      const b = acquireSeedLock(final, c);
      // A resumes and tries to commit: it is refused, at the rename and at the marker
      expect(() => a.assertHeld('the placing of the credentials file')).toThrow(SeedLockError);
      expect(existsSync(final)).toBe(false); // A placed nothing
      expect(existsSync(staged.tmp)).toBe(true); // A's stage is still its own until the sweep of an old, superseded attempt
      expect(b.held()).toBe(true);
      b.release();
    });
    it('the holder fences ITSELF when it cannot prove its lease, even before anyone has taken over', () => {
      const { final } = mk();
      const c = clockAt(2_000_000);
      const a = acquireSeedLock(final, c);
      expect(a.held()).toBe(true);
      c.t += 29_999;
      expect(a.held()).toBe(true);
      c.t += 2; // more than half of the stale time without a beat: it stops committing, a taker would still have to wait
      expect(a.held()).toBe(false);
      a.release();
    });
    it('a stage older than ten minutes owned by a resumable writer is not swept; once its writer is superseded it is', () => {
      const { d, final } = mk();
      const c = clockAt(realClock.now().getTime());
      const a = acquireSeedLock(final, c);
      const staged = stageCredentialsFile(final, 'password: A\n', a.attempt);
      const hourAgo = new Date(c.t - 3_600_000);
      utimesSync(staged.tmp, hourAgo, hourAgo); // the stage is an hour old, and A's heartbeat has not run
      // a second seed cannot even start while A's lock is live: it cannot sweep
      expect(() => acquireSeedLock(final, c)).toThrow(SeedLockError);
      expect(existsSync(staged.tmp)).toBe(true);
      // A is stalled past the stale time: B takes over. Only now is A's stage a candidate, and it is old enough
      age(d, locks(d)[0]!, c);
      c.t += 90_000;
      const b = acquireSeedLock(final, c);
      expect(a.held()).toBe(false);
      expect(sweepStaleStagedCredentials(final, b, { now: c.now }).removed).toBe(1);
      expect(existsSync(staged.tmp)).toBe(false);
      b.release();
    });
    it('a stage of the attempt itself is never swept by it, and a younger superseded one is kept by the age gate', () => {
      const { d, final } = mk();
      const c = clockAt(realClock.now().getTime());
      const a = acquireSeedLock(final, c);
      const staged = stageCredentialsFile(final, 'x', a.attempt);
      age(d, locks(d)[0]!, c);
      c.t += 90_000;
      const b = acquireSeedLock(final, c);
      expect(sweepStaleStagedCredentials(final, b, { now: c.now }).removed).toBe(0); // A's stage is only ~1.5 minutes old
      expect(existsSync(staged.tmp)).toBe(true);
      b.release();
    });
    it('the sweep refuses to run without a held lock', () => {
      const { final } = mk();
      const lock = acquireSeedLock(final);
      lock.release();
      expect(() => sweepStaleStagedCredentials(final, lock)).toThrow(/no longer holds the seed lock/);
    });
    it('a lock of the first version (no epoch) is read as epoch 0: live ones refuse, abandoned ones are taken over', () => {
      const { d, final } = mk();
      const legacy = path.join(d, SEED_LOCK_NAME);
      writeFileSync(legacy, JSON.stringify({ token: 'old' }), { mode: 0o600 });
      expect(() => acquireSeedLock(final)).toThrow(/live/);
      const old = new Date(realClock.now().getTime() - 3_600_000);
      utimesSync(legacy, old, old);
      const lock = acquireSeedLock(final);
      expect(existsSync(legacy)).toBe(false);
      expect(locks(d)).toEqual([`${SEED_LOCK_NAME}.1`]);
      lock.release();
    });
    it('the lock is exclusive between processes: a second process cannot take it', () => {
      const { final } = mk();
      const a = acquireSeedLock(final);
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          './scripts/register-ts-paths.mjs',
          '-e',
          `import('./scripts/training-lib.ts').then(m => { try { m.acquireSeedLock(${JSON.stringify(final)}); process.exit(0); } catch (e) { process.exit(e instanceof m.SeedLockError ? 3 : 4); } })`,
        ],
        { encoding: 'utf8' },
      );
      expect(r.status).toBe(3);
      a.release();
    });
  });
  it('refuses an output inside a checkout or a Docker build context, accepts a private folder outside', () => {
    const checkout = dir();
    mkdirSync(path.join(checkout, '.git'));
    expect(() => validateCredentialsPath(path.join(checkout, 'training-accounts.local.txt'))).toThrow(
      /checkout or a Docker build context/,
    );
    const nested = path.join(checkout, 'sub');
    mkdirSync(nested, { mode: 0o700 });
    expect(() => validateCredentialsPath(path.join(nested, 'training-accounts.local.txt'))).toThrow(
      /build context/,
    );
    const ctx = dir();
    writeFileSync(path.join(ctx, 'Dockerfile'), 'FROM scratch');
    expect(() => validateCredentialsPath(path.join(ctx, 'training-accounts.local.txt'))).toThrow(
      /build context/,
    );
    // the repository itself, whatever the working folder
    expect(() => validateCredentialsPath(path.join(process.cwd(), 'training-accounts.local.txt'))).toThrow(
      /build context/,
    );
    expect(validateCredentialsPath(path.join(dir(), 'training-accounts.local.txt'))).toMatch(
      /training-accounts/,
    );
  });
  it('R13: the stock path exception needs a real mount point, not a pathname', () => {
    // a build-context folder (it holds a Dockerfile) that is named like the stock volume
    const stock = dir();
    writeFileSync(path.join(stock, 'Dockerfile'), 'FROM scratch');
    const file = path.join(stock, 'training-accounts.local.txt');
    const real = realpathSync(stock);
    // the name alone is not enough: not a mount, so the checkout / build-context rule applies
    expect(() => validateCredentialsPath(file, { stockDir: real, isMount: () => false })).toThrow(
      /build context/,
    );
    // the same folder as the stock volume that IS mounted: accepted
    expect(validateCredentialsPath(file, { stockDir: real, isMount: () => true })).toMatch(
      /training-accounts/,
    );
    // a mounted folder that is not the stock path gets no exception
    expect(() => validateCredentialsPath(file, { stockDir: '/app/out', isMount: () => true })).toThrow(
      /build context/,
    );
  });
  it('R13: isMountPoint is true for the filesystem root and for a mounted folder, false for an ordinary folder', () => {
    expect(isMountPoint('/')).toBe(true);
    expect(isMountPoint(dir())).toBe(false);
    expect(isMountPoint(path.join(tmpdir(), 'bb-does-not-exist-xyz'))).toBe(false);
  });
  it('the command lines have no default output path', () => {
    for (const f of ['scripts/seed-training.ts', 'scripts/reset-training.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/TRAINING_ACCOUNTS_FILE \?\? /);
      expect(src).toMatch(/TRAINING_ACCOUNTS_FILE is required/);
    }
  });
});
