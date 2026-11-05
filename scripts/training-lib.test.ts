import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  stageCredentialsFile,
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
