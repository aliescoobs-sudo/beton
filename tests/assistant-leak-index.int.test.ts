import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { scanForLeaks } from '../src/modules/assistant';
import { cipherFrom } from '../src/modules/assistant/service/cipher';
import { forgetLeakIndex, loadLeakIndex } from '../src/modules/assistant/service/leak-index';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// assistant A6 (AC-ASSIST-05, 06): the strings the leak scan looks for, and who may ask for them.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
afterAll(() => Promise.all([app.end(), system.end()]));

const cipher = cipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS));
const marker = `li${randomUUID()
  .replace(/-/g, '')
  .slice(0, 10)
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  forgetLeakIndex();
});

describe('the leak index', () => {
  it('holds every name, number, plate and sealed phone we have, and finds each in a payload', async () => {
    const phone = '0500000067';
    await withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, async (tx) => {
      await tx.query(
        `insert into client (id, code, name, kind, ice, contact_name, phone_enc)
         values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'company', '001234567000089', $2, $3)`,
        [`Société ${marker}`, `Contact ${marker}`, cipher.seal(phone)],
      );
    });
    const index = await loadLeakIndex(system, cipher);
    for (const payload of [
      `chez Société ${marker}`,
      `appeler Contact ${marker}`,
      'ICE 001234567000089',
      'tel 05 00 00 00 67',
    ])
      expect(scanForLeaks(payload, index).length, payload).toBeGreaterThan(0);
    // A truck plate, a driver and a user of the pilot seed are in it too.
    expect(index.names.some((n) => /-A-6$/.test(n))).toBe(true);
    expect(index.names).toContain(users.owner.name);
  });

  it('is answered to the system role only: not to a person, whatever their role', async () => {
    for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
      await expect(
        withRlsContext(app, { userId: users[role].id, role, requestId: marker }, (tx) =>
          tx.query('select * from public.assistant_leak_index()'),
        ),
      ).rejects.toThrow(/permission denied|only the system role/);
    }
    await expect(app.query('select * from public.assistant_leak_index()')).rejects.toThrow(
      /permission denied/,
    );
    const ok = await withRlsContext(
      system,
      { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: marker },
      (tx) => tx.query('select kind from public.assistant_leak_index() limit 1'),
    );
    expect(ok.rowCount).toBe(1);
  });

  it('refuses to answer when it cannot read, instead of an empty index', async () => {
    forgetLeakIndex();
    const broken = new pg.Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', max: 1 });
    await expect(loadLeakIndex(broken, cipher)).rejects.toBeDefined();
    await broken.end();
  });
});
