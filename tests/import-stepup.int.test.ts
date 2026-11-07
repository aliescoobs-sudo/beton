import { randomUUID } from 'node:crypto';
import { createOTP } from '@better-auth/utils/otp';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/lib/env';
import {
  importConfirmation,
  ImportRefused,
  importWorkbook,
  rollbackConfirmation,
  rollbackImport,
  type ImportEnvironment,
  type SheetMapping,
} from '../src/modules/importer';
import { authSecretCipher } from '../src/modules/platform-security/auth/secret-cipher';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { verifyImportCode } from '../scripts/import-excel-lib';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';
import { buildWorkbook } from './helpers/xlsx-writer';
import { createHash } from 'node:crypto';

// R14-11: the second factor of the import commands has the application's protections, and the verified code is bound to its operation.
const env = testEnv();
const appEnv = loadEnv({
  ...process.env,
  DATABASE_URL_APP: env.DATABASE_URL_APP,
  DATABASE_URL_AUTH: env.DATABASE_URL_AUTH,
});
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 3 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const PROD: ImportEnvironment = { trainingMode: false, realData: true, simulationEnabled: false };
const users: string[] = [];
afterAll(async () => {
  for (const id of users) {
    await migrator.query(`delete from "twoFactor" where "userId" = $1`, [id]).catch(() => undefined);
    await migrator.query(`delete from totp_used_step where user_id = $1`, [id]).catch(() => undefined);
  }
  await Promise.all([migrator.end(), auth.end(), app.end()]);
});

const T0 = new Date('2030-06-01T10:00:00Z');
const stepOf = (d: Date) => Math.floor(d.getTime() / 30_000);
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

async function account(role: 'owner' | 'app_admin' = 'app_admin') {
  const a = await realActor(env.DATABASE_URL_MIGRATOR, role);
  const secret = Buffer.from(randomUUID()).toString('hex').slice(0, 20);
  await migrator.query(
    `insert into "twoFactor" (id, secret, "backupCodes", "userId", verified) values ($1, $2, 'f1.unused', $3, true)`,
    [randomUUID(), await authSecretCipher(appEnv).encrypt(secret), a.id],
  );
  users.push(a.id);
  return { ...a, otp: createOTP(secret), code: (d: Date) => createOTP(secret).hotp(stepOf(d)) };
}
const verify = (userId: string, code: string, now: Date) =>
  verifyImportCode(auth, appEnv, { userId, code, now });

describe('the code is claimed like the application claims it (R14-11)', () => {
  it('a code works once: used again for another operation it is refused; an earlier step is refused; the next step works', async () => {
    const u = await account();
    const first = await u.code(at(0));
    expect(await verify(u.id, first, at(0))).toBe('ok');
    expect(await verify(u.id, first, at(1))).toBe('wrong'); // replayed for a second import or a rollback
    expect(await verify(u.id, await u.code(at(-30)), at(5))).toBe('wrong'); // an earlier step than the last one used
    expect(await verify(u.id, await u.code(at(30)), at(31))).toBe('ok');
    // the claim is the application's own row
    const row = await migrator.query<{ last_step: string }>(
      'select last_step::text from totp_used_step where user_id = $1',
      [u.id],
    );
    expect(Number(row.rows[0]?.last_step)).toBe(stepOf(at(30)));
  });

  it('a code the application already used (a sign-in) cannot be used by the import either', async () => {
    const u = await account();
    await migrator.query('insert into totp_used_step (user_id, last_step) values ($1, $2)', [
      u.id,
      stepOf(at(0)),
    ]);
    expect(await verify(u.id, await u.code(at(0)), at(1))).toBe('wrong');
  });

  it('two simultaneous attempts with the same code: exactly one wins', async () => {
    const u = await account();
    const code = await u.code(at(0));
    const results = await Promise.all([verify(u.id, code, at(1)), verify(u.id, code, at(1))]);
    expect(results.sort()).toEqual(['ok', 'wrong']);
  });
});

describe('the failure budget survives a restart (R14-11)', () => {
  it('five wrong codes lock the account even for a correct one; the budget is in the database, not in the process', async () => {
    const u = await account();
    for (let i = 0; i < 5; i++) expect(await verify(u.id, '000000', at(i))).toBe('wrong'); // each call is "a new invocation"
    expect(await verify(u.id, await u.code(at(10)), at(10))).toBe('locked');
    // attempts made while locked are not counted: a later window frees it
    expect(await verify(u.id, await u.code(at(20 * 60)), at(20 * 60))).toBe('ok');
  });

  it('a success clears the failures before it', async () => {
    const u = await account();
    for (let i = 0; i < 4; i++) await verify(u.id, '000000', at(i));
    expect(await verify(u.id, await u.code(at(10)), at(10))).toBe('ok');
    for (let i = 0; i < 4; i++) expect(await verify(u.id, '000000', at(11 + i))).toBe('wrong');
  });
});

describe('eligibility is checked again at the moment of use (R14-11)', () => {
  it('an account that was disabled, demoted or lost its authenticator after the dry run gets no code accepted', async () => {
    const u = await account();
    await migrator.query(`update "user" set status = 'disabled' where id = $1`, [u.id]);
    expect(await verify(u.id, await u.code(at(0)), at(0))).toBe('ineligible');
    await migrator.query(`update "user" set status = 'active', role = 'accountant' where id = $1`, [u.id]);
    expect(await verify(u.id, await u.code(at(0)), at(0))).toBe('ineligible');
    await migrator.query(`update "user" set role = 'app_admin' where id = $1`, [u.id]);
    expect(await verify(u.id, await u.code(at(0)), at(0))).toBe('ok'); // restored: eligible again
  });
});

describe('the verified code is bound to the operation (R14-11)', () => {
  const mapping: SheetMapping = {
    version: 1,
    sheet: 'Clients',
    kind: 'clients',
    headerRow: 1,
    dateFormat: 'dmy',
    columns: {},
  };
  const file = (name: string) =>
    buildWorkbook([
      {
        name: 'Clients',
        rows: [
          ['Nom', 'Type'],
          [name, 'person'],
        ],
      },
    ]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const actorOf = async (): Promise<SessionUser> =>
    ({
      ...(await realActor(env.DATABASE_URL_MIGRATOR, 'owner')),
      locale: 'fr',
      twoFactorEnabled: true,
      reenrolRequired: false,
      stepUpVerified: true,
    }) as SessionUser;
  const run = (actor: SessionUser, buf: Buffer, stepUp?: { userId: string; operation: string }) =>
    importWorkbook({
      appPool: app,
      actor,
      file: buf,
      mappings: [mapping],
      mode: 'apply',
      environment: PROD,
      requireEveryMappedSheet: false,
      ...(stepUp ? { stepUp } : {}),
    });

  it('an apply with no proof, a proof for another file, another opening date, another account or a rollback proof is refused; nothing is written', async () => {
    const actor = await actorOf();
    const buf = file(`Client Fictif Preuve ${randomUUID().slice(0, 6)}`);
    const right = importConfirmation({
      fileSha256: sha(buf),
      mappings: [mapping],
      openingDate: null,
    }).operation;
    const other = importConfirmation({
      fileSha256: sha(file('Autre')),
      mappings: [mapping],
      openingDate: null,
    }).operation;
    const otherDate = importConfirmation({
      fileSha256: sha(buf),
      mappings: [mapping],
      openingDate: '2026-01-01',
    }).operation;
    const before = Number((await migrator.query('select count(*)::int n from client')).rows[0]?.n);
    for (const proof of [
      undefined,
      { userId: actor.id, operation: other },
      { userId: actor.id, operation: otherDate },
      { userId: randomUUID(), operation: right },
      { userId: actor.id, operation: rollbackConfirmation(randomUUID()).operation },
    ])
      await expect(run(actor, buf, proof)).rejects.toBeInstanceOf(ImportRefused);
    expect(Number((await migrator.query('select count(*)::int n from client')).rows[0]?.n)).toBe(before);
    const ok = await run(actor, buf, { userId: actor.id, operation: right });
    expect(ok.applied).toBe(true);
  });

  it('a rollback needs a proof for THAT run', async () => {
    const actor = await actorOf();
    const runId = randomUUID();
    await expect(rollbackImport({ appPool: app, actor, runId, environment: PROD })).rejects.toBeInstanceOf(
      ImportRefused,
    );
    await expect(
      rollbackImport({
        appPool: app,
        actor,
        runId,
        environment: PROD,
        stepUp: { userId: actor.id, operation: rollbackConfirmation(randomUUID()).operation },
      }),
    ).rejects.toBeInstanceOf(ImportRefused);
  });
});
