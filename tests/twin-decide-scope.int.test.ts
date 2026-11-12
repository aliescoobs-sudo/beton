import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideTwinScope, previewTwinScope } from '../scripts/training-twin-lib';
import { withRlsContext } from '../src/lib/db/rls-context';
import { listQuarantine, listStagedSets } from '../src/modules/importer';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

/**
 * T10g (R19B-12): the twin decision helper is bound to ONE named set. Two sets are staged at the same time; deciding one leaves the other's quarantine
 * untouched, a preview writes nothing, an unknown or malformed set is refused, and labels (global) are not decided while another set has pending work.
 * Synthetic rows only (fixed phrases and made-up cells); every row this suite makes ends decided and every batch rolled back, so nothing stays open for the
 * suites that share this database.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const sha = () => randomBytes(32).toString('hex');
const SET_A = sha();
const SET_B = sha();
let A: Awaited<ReturnType<typeof v1Actors>>;

const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: A.owner.id, role: 'owner', requestId: 'twin-scope' }, fn);
async function stage(setSha: string, rows: number) {
  const batch = randomUUID();
  await asOwner(async (tx) => {
    await tx.query(
      `insert into history.batch (id, kind, plant_id, set_sha, status, files, created_by) values ($1, 'deliveries', null, $2, 'staged', 1, $3)`,
      [batch, setSha, A.owner.id],
    );
    for (let i = 1; i <= rows; i++)
      await tx.query(
        `insert into history.quarantine (id, set_sha, kind, plant_id, file_ord, sheet_pos, row_no, reason, raw)
         values ($1, $2, 'deliveries', null, 1, 1, $3, 'NO_DATE', '{"client":"CLIENT FICTIF"}')`,
        [randomUUID(), setSha, i],
      );
  });
  return batch;
}
const open = async (setSha: string) =>
  (await listQuarantine(app, A.owner, { onlyOpen: true, setSha })).length;
let batchA = '';
let batchB = '';

beforeAll(async () => {
  A = await v1Actors(app, env.DATABASE_URL_MIGRATOR, `twn${randomBytes(3).toString('hex')}`);
  batchA = await stage(SET_A, 2);
  batchB = await stage(SET_B, 3);
});
afterAll(async () => {
  if (A) {
    await asOwner(async (tx) => {
      for (const b of [batchA, batchB].filter(Boolean))
        await tx.query(
          `update history.batch set status = 'rolled_back', rolled_back_by = $2, rolled_back_at = clock_timestamp() where id = $1`,
          [b, A.owner.id],
        );
      await tx.query(
        `update history.quarantine set status = 'discarded', decided_by = $2, decided_at = clock_timestamp() where set_sha = any($1) and status = 'open'`,
        [[SET_A, SET_B], A.owner.id],
      );
    });
    await A.done();
  }
  await Promise.all([app.end(), migrator.end()]);
});

describe('the twin helper acts on one named set', () => {
  it('lists the two staged sets with their counts, and a preview shows the scope without writing', async () => {
    const sets = (await listStagedSets(app, A.owner)).filter((s) => s.setSha === SET_A || s.setSha === SET_B);
    expect(sets.find((s) => s.setSha === SET_A)).toMatchObject({ openQuarantine: 2, stagedBatches: 1 });
    expect(sets.find((s) => s.setSha === SET_B)).toMatchObject({ openQuarantine: 3, stagedBatches: 1 });
    const prev = await previewTwinScope(app, A.owner, SET_A);
    expect(prev).toMatchObject({ setSha: SET_A, openQuarantine: 2, stagedBatches: 1 });
    expect(prev!.otherSets.map((o) => o.setSha)).toContain(SET_B);
    const dry = await decideTwinScope(app, A.owner, { setSha: SET_A, apply: false, quarantineOnly: true });
    expect(dry).toMatchObject({ ok: true, applied: false });
    expect(await open(SET_A)).toBe(2);
    expect(await open(SET_B)).toBe(3);
  });
  it('refuses a malformed or unknown set, and writes nothing', async () => {
    for (const bad of ['', 'abc', SET_A.toUpperCase(), SET_A.slice(1), `${SET_A}0`]) {
      const r = await decideTwinScope(app, A.owner, { setSha: bad, apply: true, quarantineOnly: false });
      expect(r.ok, bad).toBe(false);
    }
    const unknown = await decideTwinScope(app, A.owner, {
      setSha: sha(),
      apply: true,
      quarantineOnly: false,
    });
    expect(unknown).toMatchObject({ ok: false });
    expect(await open(SET_A)).toBe(2);
    expect(await open(SET_B)).toBe(3);
  });
  it('refuses to decide labels while another set has pending staging, and leaves BOTH sets untouched', async () => {
    const r = await decideTwinScope(app, A.owner, { setSha: SET_A, apply: true, quarantineOnly: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/other staged set/);
    expect(await open(SET_A)).toBe(2);
    expect(await open(SET_B)).toBe(3);
  });
  it('--quarantine-only decides ONLY the named set; the other set keeps every open row', async () => {
    const r = await decideTwinScope(app, A.owner, { setSha: SET_A, apply: true, quarantineOnly: true });
    expect(r).toMatchObject({ ok: true, applied: true, done: { 'quarantine:discard': 2 } });
    expect(await open(SET_A)).toBe(0);
    expect(await open(SET_B)).toBe(3);
    const again = await decideTwinScope(app, A.owner, { setSha: SET_B, apply: true, quarantineOnly: true });
    expect(again).toMatchObject({ ok: true, done: { 'quarantine:discard': 3 } });
    expect(await open(SET_B)).toBe(0);
  });
  it('the lister and the helper never return a row of another set', async () => {
    const rows = await listQuarantine(app, A.owner, { setSha: SET_A });
    expect(rows.length).toBe(2);
    expect(rows.every((q) => q.setSha === SET_A)).toBe(true);
  });
});
