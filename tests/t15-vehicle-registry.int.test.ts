import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createTruck,
  endSmsSender,
  fieldCipherFrom,
  listSmsSenders,
  phoneLookupHash,
  registerSmsSender,
  setTruckGpsUnit,
} from '../src/modules/master-data';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';

/** T15 G3 (SPEC-sms-channel §4, D235): the hauler kind, the GPS unit mapping and the sealed, hashed sender registry. Fictitious numbers only. */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const marker = `t15v${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const hmacKey = Buffer.alloc(32, 5).toString('base64');
const cipher = fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS));
let w: World;
type U = { id: string; role: string };
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
// invented numbers in the reserved fictitious range, never a real one; each test draws its own so the shared database never collides
const phone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const hash = (p: string) => phoneLookupHash(hmacKey, `+212${p.slice(1)}`);
const seal = (p: string) => cipher.seal(`+212${p.slice(1)}`)!;
const reg = (
  u: U,
  h: string,
  e: string,
  driver: string,
  truck: string | null = null,
  reason = 'new_driver',
) =>
  w.as(
    u,
    async (tx) =>
      (
        await tx.query<{ r: string }>(
          'select public.register_sms_sender($1,$2,$3,$4,current_date,$5,$6) as r',
          [h, e, driver, truck, reason, 'fictitious'],
        )
      ).rows[0]!.r,
  );
let driverSeq = 0;
async function freshDriver(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      return (
        await w.sup<{ id: string }>(
          `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'driver') returning id`,
          [
            `CH-${1000 + Math.floor(Math.random() * 8999)}`,
            `Registry driver ${marker} ${driverSeq++}`,
            w.owner.id,
          ],
        )
      )[0]!.id;
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  throw new Error('no free driver code');
}

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end(), system.end()]);
});

describe('T15 G3: the hauler kind and the GPS unit', () => {
  it('a hauler has an H code; the code prefix must match the kind (database and service)', async () => {
    const mk = (codeText: string, kind: string) =>
      code(() =>
        w.sup(`insert into truck (id, code, plate, kind) values (gen_random_uuid(), $1, $2, $3)`, [
          codeText,
          `HP-${marker.slice(0, 8)}-${codeText}`,
          kind,
        ]),
      );
    const n = 100 + Math.floor(Math.random() * 800);
    expect(await mk(`H${n}`, 'hauler')).toBeUndefined();
    expect(await mk(`T${n}`, 'hauler')).toBe('23514');
    expect(await mk(`H${n + 1}`, 'mixer')).toBe('23514');
    expect(await mk(`H${n + 2}`, 'nonsense')).toBe('23514');
    const r = await createTruck(app, w.owner as unknown as SessionUser, {
      code: `H${n + 3}`,
      plate: `HP-${marker.slice(0, 8)}-svc`,
      kind: 'hauler',
    });
    expect(r.ok).toBe(true);
    const bad = await createTruck(app, w.owner as unknown as SessionUser, {
      code: `H${n + 4}`,
      plate: `HP-${marker.slice(0, 8)}-bad`,
      kind: 'mixer',
    });
    expect(bad.ok).toBe(false);
  });

  it('a GPS unit maps to at most one vehicle, only the owner roles set it, and it can be cleared', async () => {
    const owner = w.owner as unknown as SessionUser;
    expect((await setTruckGpsUnit(app, owner, w.truckA, `U-${marker}`)).ok).toBe(true);
    const dup = await setTruckGpsUnit(app, owner, w.truckB, `U-${marker}`);
    expect(dup).toEqual({ ok: false, error: 'DUPLICATE' });
    // a plant manager's update reaches no row (the policy of truck): nothing changes
    const pmUpdate = await w.as(w.pmA, (tx) =>
      tx.query(`update truck set gps_unit_id = 'X' where id = $1`, [w.truckA]),
    );
    expect(pmUpdate.rowCount).toBe(0);
    expect(
      (await w.sup<{ g: string }>(`select gps_unit_id g from truck where id = $1`, [w.truckA]))[0]!.g,
    ).toBe(`U-${marker}`);
    expect((await setTruckGpsUnit(app, owner, w.truckA, null)).ok).toBe(true);
    expect((await setTruckGpsUnit(app, owner, w.truckB, `U-${marker}`)).ok).toBe(true);
    await setTruckGpsUnit(app, owner, w.truckB, null);
  });
});

describe('T15 G3: the sender registry', () => {
  it('owner and app_admin register a number: sealed and hashed, the clear number is nowhere in the row, the audit chain records it', async () => {
    const p = phone();
    const d = await freshDriver();
    const id = await reg(w.owner, hash(p), seal(p), d, w.truckA);
    const [row] = await w.sup<{ t: string; hash: string; enc: string }>(
      `select s::text t, phone_hash hash, phone_enc enc from sms_sender s where id = $1`,
      [id],
    );
    expect(row!.hash).toBe(hash(p));
    expect(row!.enc).toMatch(/^f1\./);
    expect(row!.t).not.toContain(p.slice(2));
    expect(cipher.open(row!.enc)).toBe(`+212${p.slice(1)}`);
    const found = await w.sup(`select id from sms_sender where phone_hash = $1`, [hash(p)]);
    expect(found).toHaveLength(1);
    expect(
      await w.sup(
        `select 1 from audit_event where table_name = 'sms_sender' and row_id = $1 and actor_user_id = $2`,
        [id, w.owner.id],
      ),
    ).toHaveLength(1);
    const p2 = phone();
    await reg(w.appAdmin, hash(p2), seal(p2), await freshDriver());
  });

  it('every other role is refused with 42501; the clear number is never accepted as a hash; bad input 23514', async () => {
    const p = phone();
    const d = await freshDriver();
    for (const u of [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA])
      expect(await code(async () => reg(u, hash(p), seal(p), d)), u.role).toBe('42501');
    expect(await code(async () => reg(w.owner, `+212${p.slice(1)}`, seal(p), d))).toBe('23514');
    expect(await code(async () => reg(w.owner, hash(p), p, d))).toBe('23514');
    expect(await code(async () => reg(w.owner, hash(p), seal(p), randomUUID()))).toBe('23514');
    expect(await code(async () => reg(w.owner, hash(p), seal(p), d, randomUUID()))).toBe('23514');
    expect(await code(async () => reg(w.owner, hash(p), seal(p), d, null, 'because'))).toBe('23514');
  });

  it('one open mapping per number (23505), at most two numbers per driver (23514), and a number is free again once ended', async () => {
    const d = await freshDriver();
    const [a, b, c] = [phone(), phone(), phone()];
    const first = await reg(w.owner, hash(a), seal(a), d);
    expect(await code(async () => reg(w.owner, hash(a), seal(a), await freshDriver()))).toBe('23505');
    await reg(w.owner, hash(b), seal(b), d, null, 'spare_number');
    expect(await code(async () => reg(w.owner, hash(c), seal(c), d))).toBe('23514');
    await w.as(w.appAdmin, (tx) =>
      tx.query('select public.end_sms_sender($1, current_date, $2)', [first, 'number_changed']),
    );
    await reg(w.owner, hash(c), seal(c), d);
    // the freed number can go to somebody else
    await reg(w.owner, hash(a), seal(a), await freshDriver());
  });

  it('ending: owner roles only, once, never before it started; nothing is deleted or rewritten', async () => {
    const p = phone();
    const id = await reg(w.owner, hash(p), seal(p), await freshDriver());
    const end = (u: U, day = 'current_date', why = 'lost_phone') =>
      w.as(u, (tx) => tx.query(`select public.end_sms_sender($1, ${day}, $2)`, [id, why]));
    for (const u of [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA])
      expect(await code(async () => end(u)), u.role).toBe('42501');
    expect(await code(async () => end(w.owner, `current_date - 5`))).toBe('23514');
    expect(await code(async () => end(w.owner, 'current_date', 'whatever'))).toBe('23514');
    await end(w.owner);
    expect(await code(async () => end(w.owner))).toBe('23514');
    expect(
      await code(async () =>
        migrator.query(`update sms_sender set driver_id = $2 where id = $1`, [id, await freshDriver()]),
      ),
    ).toBe('23000');
    expect(
      await code(async () =>
        migrator.query(`update sms_sender set valid_to = null, end_reason_code = null where id = $1`, [id]),
      ),
    ).toBe('23000');
    expect(await code(async () => migrator.query(`delete from sms_sender where id = $1`, [id]))).toBe(
      '23000',
    );
  });

  it('only the owner roles read the table or the list; every other role reads nothing and is refused by the door; no direct write', async () => {
    const p = phone();
    const d = await freshDriver();
    const id = await reg(w.owner, hash(p), seal(p), d);
    const rows = (u: U) =>
      w.as(u, async (tx) => (await tx.query(`select id from sms_sender where id = $1`, [id])).rows.length);
    expect(await rows(w.owner)).toBe(1);
    expect(await rows(w.appAdmin)).toBe(1);
    for (const u of [w.pmA, w.pmB, w.purchases, w.sales, w.accountant, w.driverUserA, w.partner, w.support])
      expect(await rows(u), u.role).toBe(0);
    for (const u of [w.pmA, w.purchases, w.sales, w.accountant, w.driverUserA, w.partner, w.support])
      expect(
        await code(async () => w.as(u, (tx) => tx.query('select * from public.sms_senders_list()'))),
        u.role,
      ).toBe('42501');
    for (const u of [w.owner, w.appAdmin, w.pmA])
      expect(
        await code(async () =>
          w.as(u, (tx) =>
            tx.query(
              `insert into sms_sender (phone_hash, phone_enc, driver_id, valid_from, reason_code, created_by) values ($1, $2, $3, current_date, 'new_driver', $4)`,
              [hash(phone()), seal(p), d, u.id],
            ),
          ),
        ),
        u.role,
      ).toBe('42501');
    const list = await listSmsSenders(app, w.owner as unknown as SessionUser, { cipher });
    expect(list.find((s) => s.id === id)?.phoneMasked).toBe(`•••${p.slice(-3)}`);
    expect(JSON.stringify(list)).not.toContain(p.slice(2));
  });

  it('key rotation: the system login may re-seal the number and nothing else', async () => {
    const p = phone();
    const id = await reg(w.owner, hash(p), seal(p), await freshDriver());
    const asSystem = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
      withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: marker }, fn);
    await asSystem((tx) => tx.query(`update sms_sender set phone_enc = $2 where id = $1`, [id, seal(p)]));
    expect(
      await code(async () =>
        asSystem((tx) => tx.query(`update sms_sender set note = 'x' where id = $1`, [id])),
      ),
    ).toBe('42501');
    expect(
      await code(async () =>
        asSystem((tx) =>
          tx.query(`update sms_sender set phone_hash = $2 where id = $1`, [id, hash(phone())]),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(async () => asSystem((tx) => tx.query(`delete from sms_sender where id = $1`, [id]))),
    ).toBe('42501');
  });

  it('the service: normalises the number, registers, refuses a number in use and a bad number', async () => {
    const owner = w.owner as unknown as SessionUser;
    const d = await freshDriver();
    const p = phone();
    const ok1 = await registerSmsSender(
      app,
      owner,
      {
        phone: `${p.slice(0, 2)} ${p.slice(2, 4)} ${p.slice(4)}`,
        driverId: d,
        validFrom: '2026-11-15',
        reason: 'new_driver',
      },
      { hmacKey, cipher },
    );
    expect(ok1.ok).toBe(true);
    const again = await registerSmsSender(
      app,
      owner,
      { phone: p, driverId: await freshDriver(), validFrom: '2026-11-15', reason: 'new_number' },
      { hmacKey, cipher },
    );
    expect(again).toEqual({ ok: false, error: 'NUMBER_IN_USE' });
    const bad = await registerSmsSender(
      app,
      owner,
      { phone: 'abc', driverId: d, validFrom: '2026-11-15', reason: 'new_driver' },
      { hmacKey, cipher },
    );
    expect(bad).toEqual({ ok: false, error: 'INVALID' });
    if (ok1.ok)
      expect(
        (await endSmsSender(app, owner, { id: ok1.value.id, validTo: '2026-12-01', reason: 'left_company' }))
          .ok,
      ).toBe(true);
    await expect(
      registerSmsSender(
        app,
        w.pmA as unknown as SessionUser,
        { phone: p, driverId: d, validFrom: '2026-11-15', reason: 'new_driver' },
        { hmacKey, cipher },
      ),
    ).rejects.toThrow();
  });
});
