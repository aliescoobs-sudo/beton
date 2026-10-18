import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { realClock } from '../src/modules/clock';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import {
  assertRealDataAllowed,
  getChecklist,
  markChecklistItem,
  recordRestoreTest,
} from '../src/modules/platform-security/service/checklist';
import { ForbiddenError } from '../src/modules/platform-security/service/user-admin';
import { authTestKit } from './auth-helpers';

const kit = authTestKit();
const appPool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 2 });
const systemPool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_SYSTEM, max: 2 });
afterAll(async () => {
  await Promise.all([appPool.end(), systemPool.end()]);
  await kit.close();
});

const person = (role: SessionUser['role']): SessionUser => ({
  id: randomUUID(),
  name: role,
  email: `${role}@x.test`,
  role,
  locale: 'fr',
  twoFactorEnabled: true,
  reenrolRequired: false,
});
const owner = person('owner');
const deps = () => ({ systemPool, authPool: kit.authPool, clock: realClock });
const status = async (key: string) => (await getChecklist(deps())).items.find((i) => i.key === key)?.status;

describe('security checklist (T21)', () => {
  it('starts incomplete, with the automated items computed from facts', async () => {
    const checklist = await getChecklist(deps());
    expect(checklist.complete).toBe(false);
    expect(checklist.items.find((i) => i.key === 'restore_test_recent')?.status).toBe('open');
  });

  it('the owner marks a manual item with evidence; it is audited', async () => {
    await markChecklistItem(
      appPool,
      owner,
      'csp_active',
      'e2e/security-headers.spec.ts green on 2026-10-18',
      deps(),
    );
    expect(await status('csp_active')).toBe('done');
    const [event] = await kit.auditEvents(`table_name = 'security_checklist_item' and actor_user_id = $1`, [
      owner.id,
    ]);
    expect(event).toMatchObject({ action: 'insert', row_id: 'csp_active' });
  });

  it('refuses an empty evidence, an automated item and an unknown key', async () => {
    await expect(markChecklistItem(appPool, owner, 'cndp_declaration', '  ', deps())).rejects.toThrow(
      /evidence/i,
    );
    await expect(markChecklistItem(appPool, owner, 'all_users_2fa' as never, 'x', deps())).rejects.toThrow(
      /automated|manual/i,
    );
    await expect(markChecklistItem(appPool, owner, 'nope' as never, 'x', deps())).rejects.toThrow();
  });

  it.each(['partner', 'office', 'plant'] as const)('refuses %s', async (role) => {
    await expect(
      markChecklistItem(appPool, person(role), 'cndp_declaration', 'x', deps()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses the sign-off while any other item is open', async () => {
    await expect(markChecklistItem(appPool, owner, 'owner_signoff', 'ready', deps())).rejects.toThrow(
      /open/i,
    );
  });

  it('a successful restore test recorded by the system actor marks the restore item done; a failed one does not', async () => {
    await recordRestoreTest(systemPool, { ok: false, detail: 'anchored event hash' });
    expect(await status('restore_test_recent')).toBe('open');
    await recordRestoreTest(systemPool, { ok: true, detail: 'backups/x.sql.age' });
    expect(await status('restore_test_recent')).toBe('done');
  });

  it('counts active non-owner accounts created by the bootstrap actor as seed accounts', async () => {
    const before = (await getChecklist(deps())).items.find((i) => i.key === 'no_seed_accounts')!;
    await createUser(kit.auth, kit.authPool, {
      actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
      email: `seed-${randomUUID()}@belgobeton.test`,
      name: 'Seed',
      password: kit.password,
      role: 'office',
      locale: 'fr',
    });
    const after = (await getChecklist(deps())).items.find((i) => i.key === 'no_seed_accounts')!;
    expect(Number(after.evidence)).toBe(Number(before.evidence) + 1);
    expect(after.status).toBe('open');
  });
});

describe('REAL_DATA boot guard', () => {
  it('refuses real data while the checklist is incomplete', async () => {
    await expect(assertRealDataAllowed(true, async () => ({ complete: false, items: [] }))).rejects.toThrow(
      /checklist/i,
    );
  });

  it('allows it once complete, and never checks when REAL_DATA is off', async () => {
    await expect(
      assertRealDataAllowed(true, async () => ({ complete: true, items: [] })),
    ).resolves.toBeUndefined();
    await expect(
      assertRealDataAllowed(false, async () => {
        throw new Error('not called');
      }),
    ).resolves.toBeUndefined();
  });
});
