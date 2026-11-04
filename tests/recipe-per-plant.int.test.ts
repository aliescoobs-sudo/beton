import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createPlant,
  createRecetteVersion,
  listRecetteVersions,
  resolveRecetteFor,
  updatePlant,
  type Plant,
} from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { deliveryScene, insertDelivery } from './helpers/ledger-fixtures';

// C4.1 (DECISIONS 160): a plant may have its own mix; it wins over the all-plants mix for that plant, from its own date.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `rp${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
let owner: SessionUser;
let A: Plant;
let B: Plant;
let scene: Awaited<ReturnType<typeof deliveryScene>>;
let globalId: string;
let aMixId: string;

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  expect((await migrator.query(`select 1 from plant where status = 'active'`)).rowCount).toBe(0);
  const a = await createPlant(app, owner, { code: letters(6), name: `A ${marker}` });
  if (!a.ok) throw new Error(a.error);
  A = a.value;
  // built while only A exists: the scene order belongs to A
  scene = await deliveryScene(app, owner.id, marker);
  const b = await createPlant(app, owner, { code: letters(6), name: `B ${marker}` });
  if (!b.ok) throw new Error(b.error);
  B = b.value;
  globalId = scene.recetteId;
});
afterAll(async () => {
  for (const p of [A, B]) if (p) await updatePlant(app, owner, p.id, { status: 'archived' });
  await Promise.all([app.end(), migrator.end()]);
});

const inForce = async (plantId: string | null, date: string) =>
  (
    await migrator.query<{ id: string | null }>(`select public.recette_in_force($1, $2, $3) as id`, [
      scene.typeId,
      plantId,
      date,
    ])
  ).rows[0]?.id ?? null;

describe('recipes per plant (C4.1)', () => {
  it('a plant mix has its own version numbers and dates; the all-plants mix is untouched', async () => {
    const before = (await listRecetteVersions(app, owner, scene.typeId)).length;
    const v1 = await createRecetteVersion(app, owner, scene.typeId, {
      plantId: A.id,
      effectiveFrom: '2026-05-15',
      lines: [
        { componentId: scene.cementId, qtyPerM3: 320_000 },
        { componentId: scene.sandId, qtyPerM3: 850_000 },
      ],
    });
    if (!v1.ok) throw new Error(v1.error);
    aMixId = v1.value.id;
    expect(v1.value).toMatchObject({ version: 1, plantId: A.id });
    // the same date is free for another scope, taken in its own
    const other = await createRecetteVersion(app, owner, scene.typeId, {
      plantId: B.id,
      effectiveFrom: '2026-05-15',
      lines: [{ componentId: scene.cementId, qtyPerM3: 380_000 }],
    });
    expect(other.ok && other.value.version).toBe(1);
    expect(
      await createRecetteVersion(app, owner, scene.typeId, {
        plantId: A.id,
        effectiveFrom: '2026-05-15',
        lines: [{ componentId: scene.cementId, qtyPerM3: 1 }],
      }),
    ).toEqual({ ok: false, error: 'NOT_AFTER_LATEST' });
    expect((await listRecetteVersions(app, owner, scene.typeId)).length).toBe(before + 2);
    // an unknown plant is refused
    expect(
      await createRecetteVersion(app, owner, scene.typeId, {
        plantId: randomUUID(),
        effectiveFrom: '2026-07-01',
        lines: [{ componentId: scene.cementId, qtyPerM3: 1 }],
      }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('the plant mix wins for its plant from its date; before it, and for other plants, the all-plants mix', async () => {
    expect(await inForce(A.id, '2026-05-14')).toBe(globalId);
    expect(await inForce(A.id, '2026-06-01')).toBe(aMixId);
    expect(await inForce(null, '2026-06-01')).toBe(globalId);
    const b = await inForce(B.id, '2026-06-01');
    expect(b).not.toBe(globalId);
    expect(b).not.toBe(aMixId);
    // the service resolves the same way
    const viaService = await resolveRecetteFor(app, owner, scene.typeId, '2026-06-01', A.id);
    expect(viaService.ok && viaService.value.id).toBe(aMixId);
    const noPlant = await resolveRecetteFor(app, owner, scene.typeId, '2026-06-01');
    expect(noPlant.ok && noPlant.value.id).toBe(globalId);
  });

  it('the database refuses a load that stores another mix than the one in force for its plant', async () => {
    // the scene order is plant A's, the load date is 2026-06-01: A's own mix is in force, the all-plants one is not
    await expect(
      withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
        insertDelivery(tx, owner.id, { ...scene, recetteId: globalId }, 2000),
      ),
    ).rejects.toThrow(/not the recette in force/);
    const ok = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
      insertDelivery(tx, owner.id, { ...scene, recetteId: aMixId }, 2000),
    );
    expect(ok.blNo).toMatch(/^BL-/);
    // and the stock it took is the plant's quantities (320 kg per m³ of cement for 2 m³)
    const moved = await migrator.query<{ qty_base: string }>(
      `select qty_base::text from stock_movement where source_id = $1 and component_id = $2`,
      [ok.id, scene.cementId],
    );
    expect(Number(moved.rows[0]?.qty_base)).toBe(-640_000);
  });
});
