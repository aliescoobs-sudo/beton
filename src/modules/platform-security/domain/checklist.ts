/**
 * Pre-real-data security checklist (SPEC-platform-security §8, D37). Real data may be loaded only when every item
 * is done and the owner has signed off; until then the app shows "Données fictives uniquement" and refuses to boot
 * with REAL_DATA=true.
 */
export const CHECKLIST = {
  ci_security_tests: { kind: 'manual' },
  restore_test_recent: { kind: 'automated' }, // a successful restore test in the last 35 days (monthly, with a few days of grace)
  all_users_2fa: { kind: 'automated' }, // every active user enrolled
  no_seed_accounts: { kind: 'automated' }, // no active account created by the bootstrap actor except the owner
  dependency_audit: { kind: 'manual' },
  csp_active: { kind: 'manual' },
  cndp_declaration: { kind: 'manual' }, // 🟡 D39
  // The host is Infomaniak in Switzerland (on the CNDP list of countries with adequate protection): the transfer is declared, not forbidden.
  cndp_transfer_declared: { kind: 'manual' }, // C2, replaces moroccan_hosting (D52)
  ai_zdr_contract: { kind: 'manual' }, // 🟡 D51
  rbac_second_review: { kind: 'manual' },
  backups_off_host: { kind: 'manual' }, // encrypted backups and anchors copied off the app host
  age_key_off_app_host: { kind: 'manual' }, // the age private key never on the app host
  backup_credentials_isolated: { kind: 'automated' }, // DATABASE_URL_BACKUP and the superuser password absent from the app runtime
  backup_anchor_signed: { kind: 'manual' }, // the backup receipt is signed with a key held off the app host, checked by every restore (C2)
  field_keys_escrowed_off_host: { kind: 'manual' }, // FIELD_ENCRYPTION_KEYS, RECOVERY_CODES_KEYS, AUTH_SECRETS and their retired versions kept sealed off the host (age alone does not open fields or files)
  owner_signoff: { kind: 'signoff' },
} as const;

export type ChecklistKey = keyof typeof CHECKLIST;
export const CHECKLIST_KEYS = Object.keys(CHECKLIST) as ChecklistKey[];
/** Items the owner marks by hand with evidence (the sign-off included). */
export const MANUAL_ITEMS = CHECKLIST_KEYS.filter((k) => CHECKLIST[k].kind !== 'automated');

// The runbook asks for a monthly restore test; the rule allows 35 days so that the ordinary monthly rhythm never trips it.
export const RESTORE_TEST_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;

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
  /** Whether the app runtime environment holds the backup, migrator or superuser credentials (it must not). */
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
  /** The restore test must be younger than this (default 35 days). The boot guard passes Infinity: a past pass is enough to start. */
  restoreMaxAgeMs: number = RESTORE_TEST_MAX_AGE_MS,
): { items: ChecklistItem[]; complete: boolean } {
  const automated: Record<string, { done: boolean; evidence: string }> = {
    restore_test_recent: {
      done: !!facts.lastRestoreTestOk && now.getTime() - facts.lastRestoreTestOk.getTime() <= restoreMaxAgeMs,
      evidence: facts.lastRestoreTestOk ? facts.lastRestoreTestOk.toISOString() : '',
    },
    all_users_2fa: { done: facts.usersWithout2fa === 0, evidence: `${facts.usersWithout2fa}` },
    no_seed_accounts: { done: facts.seedAccounts === 0, evidence: `${facts.seedAccounts}` },
    backup_credentials_isolated: {
      done: !facts.appHasBackupCredentials,
      evidence: facts.appHasBackupCredentials
        ? 'a backup, migrator or superuser credential is set in the app environment'
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
