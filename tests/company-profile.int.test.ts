import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  cancelInvoice,
  createInvoice,
  getCompanyProfile,
  getInvoiceDocument,
  legalMentions,
  listCompanyProfiles,
  listInvoices,
  saveCompanyProfile,
} from '../src/modules/ledger';
import { createLoad } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// ledger L29 + L30: our legal identity (versioned, insert-only, read by all, written by the owner) and the invoice as it is
// printed (AC-LED-22: the document equals the stored invoice; AC-LED-21: only owner and support).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const marker = `cp${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let scene: DeliveryScene;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
});

const profile = (extra: Record<string, unknown> = {}) => ({
  legalName: `BELGOBETON ${marker} (fictif)`,
  legalForm: 'SARL',
  ice: '001234567000089',
  ifNumber: '12345678',
  rcNumber: 'TET-4567',
  patente: '9876543',
  address: 'Zone industrielle, Tétouan (fictif)',
  rib: '181780000012345678901234',
  ...extra,
});

describe('company profile (L29)', () => {
  it('a change is a new version: the one in force is the latest that has started', async () => {
    expect(
      (
        await saveCompanyProfile(app, users.owner, profile({ effectiveFrom: '2026-01-01' }), {
          today: '2026-06-01',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await saveCompanyProfile(
          app,
          users.owner,
          profile({ legalName: `Nouveau nom ${marker}`, effectiveFrom: '2026-03-01' }),
          { today: '2026-06-01' },
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await saveCompanyProfile(
          app,
          users.owner,
          profile({ legalName: `Futur ${marker}`, effectiveFrom: '2099-01-01' }),
          { today: '2026-06-01' },
        )
      ).ok,
    ).toBe(true);
    expect((await getCompanyProfile(app, users.owner, { today: '2026-02-01' }))?.legalName).toBe(
      `BELGOBETON ${marker} (fictif)`,
    );
    expect((await getCompanyProfile(app, users.owner, { today: '2026-06-01' }))?.legalName).toBe(
      `Nouveau nom ${marker}`,
    );
    expect((await listCompanyProfiles(app, users.owner)).length).toBeGreaterThanOrEqual(3);
  });

  it('every role reads it; only the owner writes; no update or delete exists; an ICE of the wrong length is refused', async () => {
    for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
      expect((await getCompanyProfile(app, users[role], { today: '2026-06-01' }))?.ice).toBe(
        '001234567000089',
      );
    }
    for (const role of ['partner', 'office', 'plant', 'support'] as const) {
      await expect(
        saveCompanyProfile(app, users[role], profile(), { today: '2026-06-01' }),
      ).rejects.toBeDefined();
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `insert into company_profile (id, effective_from, legal_name, legal_form, ice, if_number, rc_number, patente, address, created_by)
             values (gen_random_uuid(), '2026-01-01', 'x', 'x', '001234567000089', '1', '2', '3', 'x', $1)`,
            [users[role].id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    expect(
      await saveCompanyProfile(app, users.owner, profile({ ice: '123' }), { today: '2026-06-01' }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(legalMentions((await getCompanyProfile(app, users.owner, { today: '2026-06-01' }))!)[2]).toContain(
      'ICE 001234567000089',
    );
  });
});

describe('the invoice document equals the stored invoice (AC-LED-22)', () => {
  it('lines, totals, ICE, VAT rate, term and, for a credit note, the invoice it cancels', async () => {
    const orderCode = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ code: string }>('select code from sales_order where id = $1', [scene.orderId]),
      )
    ).rows[0]?.code as string;
    const load = await createLoad(
      app,
      users.plant,
      { orderId: scene.orderId, truckId: scene.truckId, volumeL: 2500 },
      { today: '2026-06-10' },
    );
    if (!load.ok) throw new Error(load.error);
    const made = await createInvoice(app, users.owner, { orderCode }, { today: '2026-07-03' });
    if (!made.ok) throw new Error(made.error);
    const stored = (await listInvoices(app, users.owner)).find((i) => i.id === made.value.id)!;
    const doc = await getInvoiceDocument(app, users.owner, made.value.id);
    expect(doc?.invoice).toEqual(stored);
    expect(doc?.lines).toHaveLength(1);
    expect(doc?.lines[0]).toMatchObject({
      volumeL: 2500,
      unitPriceHtCentimes: 78_000,
      lineHtCentimes: 195_000,
    });
    expect(doc?.invoice.totalHtCentimes).toBe(195_000);
    expect(doc?.invoice.totalVatCentimes).toBe(39_000);
    expect(doc?.invoice.totalTtcCentimes).toBe(234_000);
    expect(doc?.termDays).toBe(60);
    expect(doc?.creditNoteOfNumber).toBeNull();
    const cn = await cancelInvoice(app, users.owner, made.value.id, 'Erreur (test)', { today: '2026-07-04' });
    if (!cn.ok) throw new Error(cn.error);
    const credit = await getInvoiceDocument(app, users.owner, cn.value.id);
    expect(credit?.creditNoteOfNumber).toBe(made.value.number);
    expect(credit?.invoice.totalTtcCentimes).toBe(-234_000);
    expect(credit?.lines[0]?.lineHtCentimes).toBe(-195_000);
  });

  it('support reads it; office, partner and plant get nothing (AC-LED-21); unknown or malformed ids are not found', async () => {
    const some = (await listInvoices(app, users.owner))[0]!;
    expect((await getInvoiceDocument(app, users.support, some.id))?.invoice.number).toBe(some.number);
    for (const role of ['office', 'partner', 'plant'] as const)
      await expect(getInvoiceDocument(app, users[role], some.id)).rejects.toBeDefined();
    expect(await getInvoiceDocument(app, users.owner, randomUUID())).toBeNull();
    expect(await getInvoiceDocument(app, users.owner, 'nope')).toBeNull();
  });
});
