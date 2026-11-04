import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { createDiskStore, type FileStore } from '../src/lib/files/store';
import { createPurchase } from '../src/modules/ledger';
import { createPlant, type Plant, updatePlant } from '../src/modules/master-data';
import {
  attachArrivalFile,
  confirmArrivalAtPlant,
  getStockLevels,
  listArrivalFiles,
  listReceiptStates,
  listReceiptVariances,
  openArrivalFile,
  recordReceipt,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { jpegWithGps } from './helpers/file-fixtures';
import { purchaseMaster, type PurchaseMaster } from './helpers/ledger-fixtures';

// C3 (REQUIREMENTS-V1 §16.7): arrived, available for production, documented; partial and rejected quantities; the weighbridge ticket
// or the delivery note attached. Quantities only, never a price. One plant is active for this file and archived at the end.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const marker = 'rs' + randomUUID().replace(/-/g, '').slice(0, 8);
const letters = (n: number) =>
  Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
const TODAY = '2026-06-10';
const SINCE = '2026-01-01';
let owner: SessionUser, plant: SessionUser, buyer: SessionUser, seller: SessionUser;
let P: Plant;
let master: PurchaseMaster;
let dir = '';
let store: FileStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bb-rs-'));
  store = createDiskStore(dir, parseKeyring(`k1:${Buffer.alloc(32, 6).toString('base64')}`));
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
  buyer = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_purchases');
  seller = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_sales');
  expect((await migrator.query(`select 1 from plant where status = 'active'`)).rowCount).toBe(0);
  const p = await createPlant(app, owner, { code: letters(6), name: `P ${marker}` });
  if (!p.ok) throw new Error(p.error);
  P = p.value;
  master = await purchaseMaster(app, owner.id, marker);
});
afterAll(async () => {
  if (P) await updatePlant(app, owner, P.id, { status: 'archived' });
  await Promise.all([app.end(), migrator.end(), rm(dir, { recursive: true, force: true })]);
});

/** A purchase of 10 t of the component; returns the purchase and its (only) line. */
async function newPurchase() {
  const made = await createPurchase(
    app,
    owner,
    {
      supplierId: master.supplierId,
      lines: [
        {
          componentId: master.componentId,
          purchaseUnitId: master.unitId,
          qtyMilli: 10_000,
          unitPriceHtCentimes: 145_000,
        },
      ],
    },
    { today: TODAY },
  );
  if (!made.ok) throw new Error(made.error);
  const line = (
    await migrator.query<{ id: string }>(`select id from purchase_line where purchase_id = $1`, [
      made.value.id,
    ])
  ).rows[0]!.id;
  return { id: made.value.id, code: made.value.code, line };
}
const level = async () =>
  (await getStockLevels(app, plant, { plantId: P.id })).find((l) => l.componentId === master.componentId)!;
const stateOf = async (code: string) =>
  (await listReceiptStates(app, plant, { since: SINCE })).find((s) => s.purchaseCode === code);

describe('receipt states (C3, §16.7)', () => {
  it('counts what arrived and what was refused, shows it as available for production, and keeps booked stock unchanged', async () => {
    const before = await level();
    const p = await newPurchase();
    const c = await confirmArrivalAtPlant(app, plant, {
      purchaseId: p.id,
      note: 'camion 1',
      lines: [{ lineId: p.line, arrivedMilli: 6000, rejectedMilli: 1000, available: true }], // 6 t arrived, 1 t refused, 5 t usable
    });
    if (!c.ok) throw new Error(c.error);
    const s = await stateOf(p.code);
    expect(s).toMatchObject({ state: 'available', documented: false, note: 'camion 1' });
    expect(s?.lines[0]).toMatchObject({
      orderedMilli: 10_000,
      arrivedMilli: 6000,
      rejectedMilli: 1000,
      available: true,
      partial: true,
    });
    const after = await level();
    expect(after.level).toBe(before.level); // nothing booked yet
    expect(after.arrivedPending).toBe(before.arrivedPending + 5_000_000); // 5 t in grams
    expect(after.usable).toBe(before.usable + 5_000_000);
    expect(JSON.stringify(s)).not.toMatch(/price|centimes|amount|total/i);
  });

  it('a counted arrival that is not marked usable stays "arrived" and adds nothing to the usable stock', async () => {
    const before = await level();
    const p = await newPurchase();
    await confirmArrivalAtPlant(app, plant, {
      purchaseId: p.id,
      lines: [{ lineId: p.line, arrivedMilli: 10_000 }],
    });
    expect((await stateOf(p.code))?.state).toBe('arrived');
    expect((await level()).arrivedPending).toBe(before.arrivedPending);
  });

  it('when the office documents the receipt the arrival leaves the pending figure and the booked stock goes up, never both', async () => {
    const p = await newPurchase();
    await confirmArrivalAtPlant(app, plant, {
      purchaseId: p.id,
      lines: [{ lineId: p.line, arrivedMilli: 10_000, available: true }],
    });
    const mid = await level();
    const r = await recordReceipt(app, owner, { purchaseId: p.id }, { today: TODAY });
    expect(r.ok).toBe(true);
    const end = await level();
    expect(end.arrivedPending).toBe(mid.arrivedPending - 10_000_000);
    expect(end.level).toBe(mid.level + 10_000_000);
    expect(end.usable).toBe(mid.usable); // the same 10 t, now booked
    expect(await stateOf(p.code)).toMatchObject({ state: 'documented', documented: true });
  });

  it('refuses a refused quantity larger than the arrival, a line of another purchase, and a role that is not the plant', async () => {
    const p = await newPurchase();
    const other = await newPurchase();
    expect(
      await confirmArrivalAtPlant(app, plant, {
        purchaseId: p.id,
        lines: [{ lineId: p.line, arrivedMilli: 1000, rejectedMilli: 2000 }],
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await confirmArrivalAtPlant(app, plant, {
        purchaseId: p.id,
        lines: [{ lineId: other.line, arrivedMilli: 1000 }],
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    await expect(confirmArrivalAtPlant(app, buyer, { purchaseId: p.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listReceiptStates(app, seller, { since: SINCE })).rejects.toBeInstanceOf(ForbiddenError);
    // nothing was left behind by the refusals
    expect(
      (await migrator.query(`select 1 from receipt_plant_confirmation where purchase_id = $1`, [p.id]))
        .rowCount,
    ).toBe(0);
  });

  it('the office purchases reads the counts to document them; the plant manager of another plant does not see this plant', async () => {
    const p = await newPurchase();
    await confirmArrivalAtPlant(app, plant, {
      purchaseId: p.id,
      lines: [{ lineId: p.line, arrivedMilli: 4000, rejectedMilli: 4000 }],
    });
    const seen = (await listReceiptStates(app, buyer, { since: SINCE })).find(
      (x) => x.purchaseCode === p.code,
    );
    expect(seen?.lines[0]).toMatchObject({ arrivedMilli: 4000, rejectedMilli: 4000, available: false });
  });

  it('keeps the weighbridge ticket or the delivery note: checked, sealed, listed, audited, readable by the office purchases only among the offices', async () => {
    const p = await newPurchase();
    const c = await confirmArrivalAtPlant(app, plant, {
      purchaseId: p.id,
      lines: [{ lineId: p.line, arrivedMilli: 3000 }],
    });
    if (!c.ok) throw new Error(c.error);
    const jpeg = { declaredType: 'image/jpeg', bytes: new Uint8Array(jpegWithGps()) };
    const made = await attachArrivalFile(
      app,
      plant,
      { confirmationId: c.value.confirmationId, kind: 'weighbridge_ticket' },
      jpeg,
      { store },
    );
    if (!made.ok) throw new Error(made.error);
    expect(
      (
        await attachArrivalFile(
          app,
          plant,
          { confirmationId: c.value.confirmationId, kind: 'delivery_note' },
          { declaredType: 'application/x-msdownload', bytes: new Uint8Array([77, 90]) },
          { store },
        )
      ).ok,
    ).toBe(false);
    const listed = await listArrivalFiles(app, buyer, [c.value.confirmationId]);
    expect(listed).toEqual([
      {
        id: made.value.id,
        confirmationId: c.value.confirmationId,
        kind: 'weighbridge_ticket',
        contentType: 'image/jpeg',
      },
    ]);
    const opened = await openArrivalFile(app, buyer, made.value.id, { store });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.bytes.toString('latin1')).not.toMatch(/GPS|Exif/);
    expect(
      (
        await migrator.query(`select 1 from audit_event where table_name = $1 and row_id = $2`, [
          `file:receipt_arrival:${p.code}`,
          made.value.id,
        ])
      ).rowCount,
    ).toBeGreaterThanOrEqual(1);
    await expect(openArrivalFile(app, seller, made.value.id, { store })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // once the office has documented the receipt, no more document is added to the arrival
    await recordReceipt(app, owner, { purchaseId: p.id }, { today: TODAY });
    expect(
      await attachArrivalFile(
        app,
        owner,
        { confirmationId: c.value.confirmationId, kind: 'delivery_note' },
        jpeg,
        { store },
      ),
    ).toEqual({ ok: false, error: 'ALREADY_DOCUMENTED' });
  });
});

describe('variance between the plant count and the office receipt (C4.2)', () => {
  /** The plant counts `usable` (nothing refused), then the office documents `office`; returns the purchase and the variances. */
  async function run(plantMilli: number, officeMilli: number, rejected = 0) {
    const p = await newPurchase();
    const c = await confirmArrivalAtPlant(app, plant, {
      purchaseId: p.id,
      lines: [
        { lineId: p.line, arrivedMilli: plantMilli + rejected, rejectedMilli: rejected, available: true },
      ],
    });
    if (!c.ok) throw new Error(c.error);
    const r = await recordReceipt(
      app,
      owner,
      { purchaseId: p.id, lines: [{ lineId: p.line, qtyMilli: officeMilli }] },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    const state = await stateOf(p.code);
    const v = await listReceiptVariances(app, buyer, [state!.confirmationId]);
    return { p, v };
  }
  const alerts = async (code: string) =>
    (
      await migrator.query(
        `select 1 from notification where kind = 'receipt_variance' and params->>'purchase' = $1`,
        [code],
      )
    ).rowCount;

  it('the same quantity is no variance and raises nothing', async () => {
    const { p, v } = await run(10_000, 10_000);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      plantMilli: 10_000,
      officeMilli: 10_000,
      varianceMilli: 0,
      varianceBp: 0,
      overThreshold: false,
    });
    expect(await alerts(p.code)).toBe(0);
  });

  it('a gap within the threshold is recorded and does not alert; above it is flagged and notified', async () => {
    const within = await run(10_000, 9_900); // 1 % under, threshold 2 %
    expect(within.v[0]).toMatchObject({
      varianceMilli: -100,
      varianceBp: 100,
      thresholdBp: 200,
      overThreshold: false,
    });
    expect(await alerts(within.p.code)).toBe(0);
    const over = await run(10_000, 9_500); // 5 % under
    expect(over.v[0]).toMatchObject({ varianceMilli: -500, varianceBp: 500, overThreshold: true });
    expect(await alerts(over.p.code)).toBeGreaterThan(0);
    const more = await run(9_000, 9_300); // 3.3 % over the plant's count
    expect(more.v[0]).toMatchObject({ varianceMilli: 300, varianceBp: 333, overThreshold: true });
  });

  it('is measured against what was usable at the plant (arrived minus refused), not against what arrived', async () => {
    const { v } = await run(5_000, 5_000, 1_000); // 6 t arrived, 1 t refused, office documents the 5 t usable
    expect(v[0]).toMatchObject({
      plantMilli: 5_000,
      officeMilli: 5_000,
      varianceMilli: 0,
      overThreshold: false,
    });
    const wrong = await run(5_000, 6_000, 1_000); // office documents the 6 t that arrived: 20 % over the usable count
    expect(wrong.v[0]).toMatchObject({ varianceMilli: 1_000, varianceBp: 2000, overThreshold: true });
  });

  it('a variance row cannot be changed or removed, and the plant manager of another plant does not see it', async () => {
    const { v } = await run(10_000, 9_000);
    await expect(
      migrator.query(`update receipt_variance set over_threshold = false where confirmation_id = $1`, [
        v[0]!.confirmationId,
      ]),
    ).rejects.toThrow(/insert-only/);
    await expect(
      migrator.query(`delete from receipt_variance where confirmation_id = $1`, [v[0]!.confirmationId]),
    ).rejects.toThrow(/insert-only/);
    // roles that never read receipts (the sales office) are refused by the service
    await expect(listReceiptVariances(app, seller, [v[0]!.confirmationId])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(JSON.stringify(v)).not.toMatch(/price|centimes|amount|total/i);
  });
});
