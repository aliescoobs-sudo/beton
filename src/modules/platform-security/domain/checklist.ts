/**
 * Pre-real-data security checklist (SPEC-platform-security §8, D37). Real data may be loaded only when every item
 * is done and the owner has signed off; until then the app shows "Données fictives uniquement" and refuses to boot
 * with REAL_DATA=true.
 */
export const CHECKLIST = {
  ci_security_tests: { kind: 'manual' },
  restore_test_recent: { kind: 'automated' }, // a successful restore test in the last 7 days
  all_users_2fa: { kind: 'automated' }, // every active user enrolled
  no_seed_accounts: { kind: 'automated' }, // no active account created by the bootstrap actor except the owner
  dependency_audit: { kind: 'manual' },
  csp_active: { kind: 'manual' },
  cndp_declaration: { kind: 'manual' }, // 🟡 D39
  moroccan_hosting: { kind: 'manual' }, // 🟡 D52
  ai_zdr_contract: { kind: 'manual' }, // 🟡 D51
  rbac_second_review: { kind: 'manual' },
  backups_off_host: { kind: 'manual' }, // encrypted backups and anchors copied off the app host
  age_key_off_app_host: { kind: 'manual' }, // the age private key never on the app host
  backup_credentials_isolated: { kind: 'automated' }, // DATABASE_URL_BACKUP absent from the app runtime
  owner_signoff: { kind: 'signoff' },
} as const;

export type ChecklistKey = keyof typeof CHECKLIST;
export const CHECKLIST_KEYS = Object.keys(CHECKLIST) as ChecklistKey[];
/** Items the owner marks by hand with evidence (the sign-off included). */
export const MANUAL_ITEMS = CHECKLIST_KEYS.filter((k) => CHECKLIST[k].kind !== 'automated');

export const RESTORE_TEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ManualMark {
  status: 'open' | 'done';
  evidence: string;
  checkedAt: Date;
  checkedBy: string;
}

export interface ChecklistFacts {
  manual: Partial<Record<string, ManualMark>>;
  lastRestoreTestOk: Date | null;
  usersWithout2fa: number;
  seedAccounts: number;
  /** Whether the app runtime environment holds the backup role credentials (it must not). */
  appHasBackupCredentials: boolean;
}

export interface ChecklistItem {
  key: ChecklistKey;
  kind: 'manual' | 'automated' | 'signoff';
  status: 'open' | 'done';
  evidence?: string;
  checkedAt?: Date;
}

export function computeChecklist(
  facts: ChecklistFacts,
  now: Date,
): { items: ChecklistItem[]; complete: boolean } {
  const automated: Record<string, { done: boolean; evidence: string }> = {
    restore_test_recent: {
      done:
        !!facts.lastRestoreTestOk &&
        now.getTime() - facts.lastRestoreTestOk.getTime() <= RESTORE_TEST_MAX_AGE_MS,
      evidence: facts.lastRestoreTestOk ? facts.lastRestoreTestOk.toISOString() : '',
    },
    all_users_2fa: { done: facts.usersWithout2fa === 0, evidence: `${facts.usersWithout2fa}` },
    no_seed_accounts: { done: facts.seedAccounts === 0, evidence: `${facts.seedAccounts}` },
    backup_credentials_isolated: {
      done: !facts.appHasBackupCredentials,
      evidence: facts.appHasBackupCredentials
        ? 'DATABASE_URL_BACKUP is set in the app environment'
        : 'absent',
    },
  };

  const items: ChecklistItem[] = CHECKLIST_KEYS.filter((k) => k !== 'owner_signoff').map((key) => {
    const kind = CHECKLIST[key].kind;
    if (kind === 'automated') {
      const a = automated[key]!;
      return { key, kind, status: a.done ? 'done' : 'open', evidence: a.evidence };
    }
    const mark = facts.manual[key];
    return mark?.status === 'done'
      ? { key, kind, status: 'done', evidence: mark.evidence, checkedAt: mark.checkedAt }
      : { key, kind, status: 'open' };
  });

  const othersDone = items.every((i) => i.status === 'done');
  const signoff = facts.manual.owner_signoff;
  items.push(
    othersDone && signoff?.status === 'done'
      ? {
          key: 'owner_signoff',
          kind: 'signoff',
          status: 'done',
          evidence: signoff.evidence,
          checkedAt: signoff.checkedAt,
        }
      : { key: 'owner_signoff', kind: 'signoff', status: 'open' },
  );
  return { items, complete: items.every((i) => i.status === 'done') };
}
