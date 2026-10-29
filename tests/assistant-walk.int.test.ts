import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { listProposals } from '../src/modules/assistant/service/proposals';
import { seedAssistantWalk } from '../src/modules/assistant/service/pilot-assistant';
import { cipherFrom } from '../src/modules/assistant/service/cipher';
import { parseKeyring } from '../src/lib/crypto/keyring';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { clientWithLoads, deliveryScene, newDelivery, orderMaster } from './helpers/ledger-fixtures';

// assistant A10 (AC-ASSIST-30): the walk of db:scenario, as the Fake provider plays it.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), auth.end(), system.end(), migrator.end()]));

const marker = `aw${randomUUID()
  .replace(/-/g, '')
  .slice(0, 10)
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;
let office: SessionUser;
let plant: SessionUser;

beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
  plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  const scene = await deliveryScene(app, owner.id, marker);
  const master = await orderMaster(app, owner.id, marker);
  await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
    tx.query('update client set name = $2 where id = $1', [master.clientId, `mc${marker}`]),
  );
  await clientWithLoads(app, owner.id, master, scene, [[3000, 2000]]);
  await newDelivery(app, owner.id, marker, scene, 800);
});

describe('the assistant walk of db:scenario', () => {
  it('plays office and plant through the application’s own door, leaves their drafts pending, and is idempotent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const deps = {
      appPool: app,
      authPool: auth,
      systemPool: system,
      env,
      today: '2026-06-02',
      users: { office, plant },
    };
    const first = await seedAssistantWalk(deps);
    expect(first.applied).toBe(true);
    expect(first.turns).toBeGreaterThanOrEqual(6);
    const cipher = cipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS));
    const mine = async (user: SessionUser) =>
      listProposals({ appPool: app, cipher, today: '2026-06-02' }, user);
    expect((await mine(office)).map((c) => c.action)).toContain('record_payment');
    expect((await mine(plant)).map((c) => c.action)).toContain('record_return');
    for (const c of [...(await mine(office)), ...(await mine(plant))]) expect(c.status).toBe('pending');
    // Office's draft shows no amount.
    expect(JSON.stringify((await mine(office)).find((c) => c.action === 'record_payment'))).not.toMatch(
      /MAD|12\s?000/,
    );
    // Every turn is recorded and audited as that person.
    const asked = await withRlsContext(app, { userId: office.id, role: 'office', requestId: marker }, (tx) =>
      tx.query<{ outcome: string }>(
        'select outcome from ai_interaction where user_id = $1 order by created_at',
        [office.id],
      ),
    );
    expect(asked.rows.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok']);
    const audit = await migrator.query(
      'select 1 from audit_event where actor_user_id = $1 and table_name = $2',
      [office.id, 'ai_interaction'],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(3);
    // The walk makes no network call and confirms nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const second = await seedAssistantWalk(deps);
    expect(second.applied).toBe(false);
    expect(second.skipped.join(' ')).toMatch(/office: already played/);
    expect(second.skipped.join(' ')).toMatch(/plant: already played/);
  });
});
