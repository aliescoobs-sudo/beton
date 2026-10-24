import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLoad, getDeliveryNote, recordNotePrint } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O7: the delivery note data. AC-OPS-11: every role reads it, none sees a price, total, plan or payment.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const roles = ['owner', 'partner', 'office', 'plant', 'support'] as const;
const users = {} as Record<(typeof roles)[number], SessionUser>;
const marker = `dn${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let scene: DeliveryScene;
let deliveryId = '';
let blNo = '';

beforeAll(async () => {
  for (const role of roles) users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  scene = await deliveryScene(app, users.owner.id, marker);
  const load = await createLoad(
    app,
    users.plant,
    { orderId: scene.orderId, truckId: scene.truckId, volumeL: 6000 },
    { today: '2026-06-02' },
  );
  if (!load.ok) throw new Error(load.error);
  deliveryId = load.value.id;
  blNo = load.value.blNo;
});

describe('delivery note (AC-OPS-11)', () => {
  it('every role reads it: BL number, client, type, volume, truck', async () => {
    for (const role of roles) {
      const note = await getDeliveryNote(app, users[role], deliveryId);
      expect(note, role).toMatchObject({
        blNo,
        volumeL: 6000,
        cancelled: false,
        clientCode: expect.stringMatching(/^CLT-/),
        truckCode: 'T1',
      });
    }
  });

  it('the client name is on the note for everyone but the plant', async () => {
    expect((await getDeliveryNote(app, users.office, deliveryId))?.clientName).toBe(`dl${marker}`);
    expect((await getDeliveryNote(app, users.owner, deliveryId))?.clientName).toBe(`dl${marker}`);
    expect((await getDeliveryNote(app, users.plant, deliveryId))?.clientName).toBeNull();
  });

  it('carries no price, total, plan, payment or client contact, for any role', async () => {
    for (const role of roles) {
      const note = await getDeliveryNote(app, users[role], deliveryId);
      expectNoFields(note, [
        'unitPriceHtCentimes',
        'totalTtcCentimes',
        'totalHtCentimes',
        'amountCentimes',
        'phone',
        'email',
        'planItems',
        'payment',
      ]);
      expect(JSON.stringify(note)).not.toMatch(/\b(78000|780000|156000|936000)\b/);
    }
  });

  it('an unknown or malformed id gives nothing', async () => {
    expect(await getDeliveryNote(app, users.plant, randomUUID())).toBeNull();
    expect(await getDeliveryNote(app, users.plant, 'not-a-uuid')).toBeNull();
  });

  it('a print is audited as an export, by the printer', async () => {
    await recordNotePrint(app, users.office, blNo);
    const { rows } = await migrator.query<{ n: string }>(
      `select count(*)::text as n from audit_event where action = 'export' and table_name = $1 and actor_user_id = $2`,
      [`print:delivery-note:${blNo}`, users.office.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
