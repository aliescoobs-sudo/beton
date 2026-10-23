import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  componentCostPerM3For,
  listConcreteTypes,
  listPurchasePrices,
  listRecetteVersions,
  listSellingPrices,
  resolveSellingPriceFor,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';

// AC-SEC-05, master-data part (T17): the plant sees no price and no cost; the office sees no cost or margin field.
// Runs on the pilot seed, so the figures are the seeded ones (B25 on 2026-10-22).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
let b25 = '';
const DATE = '2026-10-22';
const COST_FIELDS = ['componentCostPerM3Centimes', 'costPerM3', 'marginCentimes', 'margin', 'purchase_price'];
const PRICE_FIELDS = [
  'priceHtCentimes',
  'priceHtPerM3Centimes',
  'price_ht_centimes',
  'selling_price',
  ...COST_FIELDS,
];

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  b25 = (await listConcreteTypes(app, users.owner)).find((t) => t.code === 'B25')?.id ?? '';
});

describe('master data: what each role sees of prices and costs (AC-SEC-05)', () => {
  it('the plant reads recette quantities with no price or cost, and is refused every price and cost read', async () => {
    const recette = await listRecetteVersions(app, users.plant, b25);
    expect(recette[0]?.lines.length).toBe(6);
    expectNoFields(recette, PRICE_FIELDS);
    await expect(listPurchasePrices(app, users.plant)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSellingPrices(app, users.plant)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resolveSellingPriceFor(app, users.plant, b25, null, DATE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(componentCostPerM3For(app, users.plant, b25, DATE)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['office', 'partner'] as const)(
    '%s sees recettes with no cost or margin field and is refused every price and cost read (DECISIONS 81)',
    async (role) => {
      expectNoFields(await listRecetteVersions(app, users[role], b25), [...PRICE_FIELDS, ...COST_FIELDS]);
      await expect(listSellingPrices(app, users[role], { concreteTypeId: b25 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(listPurchasePrices(app, users[role])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(componentCostPerM3For(app, users[role], b25, DATE)).rejects.toBeInstanceOf(ForbiddenError);
    },
  );

  it.each(['owner', 'support'] as const)(
    '%s gets the computed cost of one m³ of B25: 776,16 MAD, under the 850,00 MAD list price',
    async (role) => {
      // 350 kg × 1 450/t + 800 kg × 90/t + 400 kg × 110/t + 600 kg × 105/t + 180 L × 12/m³ + 3,5 L × 25/L
      expect(await componentCostPerM3For(app, users[role], b25, DATE)).toEqual({ ok: true, value: 77_616 });
      const list = (await listSellingPrices(app, users[role], { concreteTypeId: b25 })).find(
        (p) => !p.clientId,
      );
      expect(list?.priceHtPerM3Centimes).toBe(85_000);
    },
  );
});
