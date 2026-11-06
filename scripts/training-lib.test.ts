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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePin } from '../src/modules/field/domain/pin';
import { checkPassword } from '../src/modules/platform-security/auth/password-policy';
import {
  PASSWORD_ACCOUNTS,
  emailOf,
  generatePassword,
  generatePin,
  commitCredentialsFile,
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
    for (const a of PASSWORD_ACCOUNTS) expect(emailOf(a.login)).toMatch(/@formation\.beton\.invalid$/);
  });
  it('the file lists every credential once and says the data are fictitious', () => {
    const text = renderCredentialsFile(
      'https://beton.aliobsil.com',
      [
        {
          label: 'Propriétaire',
          role: 'owner',
          login: 'a@formation.beton.invalid',
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
  it('the startup sweep removes staged files of an earlier crash, old and new names, and nothing else', () => {
    const d = dir();
    const final = path.join(d, 'training-accounts.local.txt');
    writeFileSync(final, 'keep', { mode: 0o600 });
    writeFileSync(path.join(d, 'training-accounts.staging-0123456789ab.local.txt'), 'stale', { mode: 0o600 });
    writeFileSync(path.join(d, '.training-accounts.local.txt.abcdef012345'), 'stale', { mode: 0o600 });
    writeFileSync(path.join(d, 'notes.txt'), 'mine');
    symlinkSync('/etc/hosts', path.join(d, 'training-accounts.staging-aaaaaaaaaaaa.local.txt'));
    expect(sweepStaleStagedCredentials(final)).toBe(2);
    expect(readdirSync(d).sort()).toEqual(
      ['notes.txt', 'training-accounts.local.txt', 'training-accounts.staging-aaaaaaaaaaaa.local.txt'].sort(),
    );
    expect(readFileSync(final, 'utf8')).toBe('keep');
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
