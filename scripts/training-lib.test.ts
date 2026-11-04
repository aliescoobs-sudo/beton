import { describe, expect, it } from 'vitest';
import { parsePin } from '../src/modules/field/domain/pin';
import { checkPassword } from '../src/modules/platform-security/auth/password-policy';
import {
  PASSWORD_ACCOUNTS,
  emailOf,
  generatePassword,
  generatePin,
  renderCredentialsFile,
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
