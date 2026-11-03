import { describe, expect, it } from 'vitest';
import { CHECKLIST, computeChecklist, type ChecklistFacts, MANUAL_ITEMS } from './checklist';

const now = new Date('2026-11-23T10:00:00Z');
const allManualDone = Object.fromEntries(
  MANUAL_ITEMS.map((key) => [
    key,
    { status: 'done' as const, evidence: 'ok', checkedAt: now, checkedBy: 'o' },
  ]),
);
const facts = (overrides: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
  manual: allManualDone,
  lastRestoreTestOk: new Date('2026-11-20T10:00:00Z'),
  usersWithout2fa: 0,
  seedAccounts: 0,
  appHasBackupCredentials: false,
  ...overrides,
});

describe('security checklist (T21, SPEC §8, D37)', () => {
  it('covers the SPEC §8 items plus the owner sign-off', () => {
    expect(Object.keys(CHECKLIST)).toEqual([
      'ci_security_tests',
      'restore_test_recent',
      'all_users_2fa',
      'no_seed_accounts',
      'dependency_audit',
      'csp_active',
      'cndp_declaration',
      'cndp_transfer_declared',
      'ai_zdr_contract',
      'rbac_second_review',
      'backups_off_host',
      'age_key_off_app_host',
      'backup_credentials_isolated',
      'backup_anchor_signed',
      'field_keys_escrowed_off_host',
      'owner_signoff',
    ]);
  });

  it('is complete only when every item is done', () => {
    expect(computeChecklist(facts(), now).complete).toBe(true);
    expect(
      computeChecklist(facts({ manual: { ...allManualDone, cndp_declaration: undefined } }), now).complete,
    ).toBe(false);
  });

  it('computes the automated items', () => {
    const items = (f: Partial<ChecklistFacts>) =>
      Object.fromEntries(computeChecklist(facts(f), now).items.map((i) => [i.key, i.status]));
    // Monthly restore test (runbook) with a few days of grace: 35 days, not 7 (a weekly rule would stop production after any quiet week).
    const DAY = 86_400_000;
    expect(items({ lastRestoreTestOk: new Date(now.getTime() - 30 * DAY) }).restore_test_recent).toBe('done');
    expect(items({ lastRestoreTestOk: new Date(now.getTime() - 35 * DAY) }).restore_test_recent).toBe('done');
    expect(
      items({ lastRestoreTestOk: new Date(now.getTime() - 35 * DAY - 60_000) }).restore_test_recent,
    ).toBe('open');
    expect(items({ lastRestoreTestOk: null }).restore_test_recent).toBe('open');
    expect(items({ usersWithout2fa: 1 }).all_users_2fa).toBe('open');
    expect(items({ seedAccounts: 2 }).no_seed_accounts).toBe('open');
    expect(items({ appHasBackupCredentials: true }).backup_credentials_isolated).toBe('open');
  });

  it('ignores a manual mark on an automated item', () => {
    const forged = {
      ...allManualDone,
      all_users_2fa: { status: 'done' as const, evidence: 'trust me', checkedAt: now, checkedBy: 'o' },
    };
    const item = computeChecklist(facts({ manual: forged, usersWithout2fa: 3 }), now).items.find(
      (i) => i.key === 'all_users_2fa',
    );
    expect(item?.status).toBe('open');
  });

  it('does not count the sign-off while another item is open', () => {
    const result = computeChecklist(facts({ usersWithout2fa: 1 }), now);
    expect(result.items.find((i) => i.key === 'owner_signoff')?.status).toBe('open');
    expect(result.complete).toBe(false);
  });
});
