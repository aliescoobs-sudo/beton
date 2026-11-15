import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOTP } from '@better-auth/utils/otp';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultMappings,
  importConfirmation,
  rollbackConfirmation,
  writeDefaultMappingFiles,
} from '../src/modules/importer';
import { authSecretCipher } from '../src/modules/platform-security/auth/secret-cipher';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';
import { buildWorkbook } from './helpers/xlsx-writer';

// T2: the command line, end to end, as a child process: refusals, the typed confirmation, the second factor, the report. The
// database is the test database; the "production flags" are set on the child only. Synthetic data only.
const env = testEnv();
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
mkdirSync('.logs', { recursive: true });
const dir = mkdtempSync(join('.logs', 't2-cli-'));
afterAll(async () => {
  // the synthetic authenticator row is not a real sealed record: leave none for the key-rotation suite to trip over
  await migrator.query(`delete from "twoFactor" where "userId" = $1`, [userId]).catch(() => undefined);
  await migrator.end();
  rmSync(dir, { recursive: true, force: true });
});
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const PROD = { REAL_DATA: 'true', SIMULATION_ENABLED: 'false', TRAINING_MODE: 'false' };
const childEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  DATABASE_URL_APP: env.DATABASE_URL_APP,
  DATABASE_URL_AUTH: env.DATABASE_URL_AUTH,
  ...extra,
});
const cli = (args: string[], extra: Record<string, string> = {}, input = '') => {
  const r = spawnSync(
    process.execPath,
    ['--import', './scripts/register-ts-paths.mjs', 'scripts/import-excel.ts', ...args],
    {
      env: childEnv(extra),
      input,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const count = async (table: string, where = 'true') =>
  Number(
    (await migrator.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`)).rows[0]
      ?.n,
  );

let email = '';
let userId = '';
let secret = '';
const CLIENT = `Client Fictif CLI ${tag}`;
const book = join(dir, 'fake-book.xlsx');
const mappingDir = join(dir, 'mapping');

beforeAll(async () => {
  const admin = await realActor(env.DATABASE_URL_MIGRATOR, 'app_admin');
  email = admin.email;
  userId = admin.id;
  secret = Buffer.from(randomUUID()).toString('hex').slice(0, 20);
  const sealed = await authSecretCipher(env).encrypt(secret);
  await migrator.query(
    `insert into "twoFactor" (id, secret, "backupCodes", "userId", verified) values ($1, $2, 'f1.unused', $3, true)`,
    [randomUUID(), sealed, userId],
  );
  writeFileSync(
    book,
    buildWorkbook([
      {
        name: 'Clients',
        rows: [
          ['Nom', 'Type', 'ICE', 'Téléphone'],
          [CLIENT, 'company', String(Math.floor(Math.random() * 9e14) + 1e14), '0000 00 0000'],
        ],
      },
      {
        name: 'Prix',
        rows: [
          ['Type', 'Prix', 'Date'],
          ['NOPE', '700', '01/12/2026'],
        ],
      },
    ]),
  );
  writeDefaultMappingFiles(mappingDir);
});

describe('arguments and refusals', () => {
  it('explains a bad command line with exit code 2 and does nothing', () => {
    expect(cli([]).code).toBe(2);
    expect(cli(['--apply', book]).out).toMatch(/needs --account/);
    expect(cli(['--dry-run']).out).toMatch(/needs a value/);
    expect(cli(['--dry-run', book, '--apply', book]).out).toMatch(/cannot be combined/);
    expect(cli(['--bogus']).code).toBe(2);
  });
  it('refuses on the training instance before it reads the file or opens the database', () => {
    const r = cli(['--dry-run', book], {
      TRAINING_MODE: 'true',
      DATABASE_URL_APP: 'postgres://nobody@127.0.0.1:1/none',
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TRAINING_MODE=true/);
  });
  it('refuses unless REAL_DATA=true and the simulation is off, even for a dry run', () => {
    const dev = cli(['--dry-run', book], {
      REAL_DATA: 'false',
      SIMULATION_ENABLED: 'true',
      TRAINING_MODE: 'false',
    });
    expect(dev.code).toBe(1);
    expect(dev.out).toMatch(/SIMULATION_ENABLED|REAL_DATA/);
  });
  it('writes editable mapping files and never overwrites one', () => {
    const d = join(dir, 'init');
    expect(cli(['--init-mapping', d]).out.match(/written/g)).toHaveLength(17);
    expect(cli(['--init-mapping', d]).out.match(/kept/g)).toHaveLength(17);
    expect(readdirSync(d)).toContain('clients.json');
  });
});

describe('dry run, confirmation, second factor', () => {
  it('a dry run reports row numbers and problems, no cell of the file, and writes nothing', async () => {
    const r = cli(['--dry-run', book, '--account', email], PROD);
    expect(r.code).toBe(1); // the Prix sheet names an unknown type: the file has a problem
    expect(r.out).toMatch(/\[Sheet \d+\] selling_prices/);
    expect(r.out).toMatch(/row 2: unknown concrete type/);
    expect(r.out).not.toContain(CLIENT);
    expect(r.out).toMatch(/sha256 [0-9a-f]{64}/);
    expect(await count('client', `name = '${CLIENT}'`)).toBe(0);
  });
  it('an apply of a file with a problem asks nothing and writes nothing', async () => {
    const r = cli(['--apply', book, '--account', email], PROD);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Nothing applied/);
    expect(await count('client', `name = '${CLIENT}'`)).toBe(0);
  });

  const good = join(dir, 'good.xlsx');
  const sheetFor = (name: string) =>
    buildWorkbook([
      {
        name: 'Clients',
        rows: [
          ['Nom', 'Type', 'ICE'],
          [name, 'company', String(Math.floor(Math.random() * 9e14) + 1e14)],
        ],
      },
    ]);
  const totp = () => createOTP(secret).totp();
  // a code of the NEXT 30-second step: the application's one-time-step rule refuses a second use of the current one (R14-11)
  const nextTotp = () => createOTP(secret).hotp(Math.floor(Date.now() / 30_000) + 1);
  const phraseFor = (sha: string) =>
    importConfirmation({ fileSha256: sha, mappings: defaultMappings(), openingDate: null }).phrase;

  it('the wrong confirmation, or three wrong codes, write nothing; the failures are audited', async () => {
    writeFileSync(good, sheetFor(CLIENT));
    const peek = cli(['--dry-run', good, '--account', email], PROD);
    expect(peek.code).toBe(0);
    const sha = /sha256 ([0-9a-f]{64})/.exec(peek.out)![1]!;
    const wrongPhrase = cli(['--apply', good, '--account', email], PROD, 'IMPORT 000000000000\n');
    expect(wrongPhrase.code).toBe(1);
    expect(wrongPhrase.out).toMatch(/Confirmation not typed/);
    const wrongCodes = cli(
      ['--apply', good, '--account', email],
      PROD,
      `${phraseFor(sha)}\n000000\n111111\n222222\n`,
    );
    expect(wrongCodes.code).toBe(1);
    expect(wrongCodes.out).toMatch(/Second factor not given/);
    expect(await count('client', `name = '${CLIENT}'`)).toBe(0);
    expect(
      await count(
        'audit_event',
        `actor_user_id = '${userId}' and action = 'permission_denied' and table_name = 'import'`,
      ),
    ).toBe(3);
  });

  it('with the typed phrase and a good code it applies in one transaction, audited with the hash; a second run does nothing', async () => {
    const sha = /sha256 ([0-9a-f]{64})/.exec(cli(['--dry-run', good, '--account', email], PROD).out)![1]!;
    const ok = cli(['--apply', good, '--account', email], PROD, `${phraseFor(sha)}\n${await totp()}\n`);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toMatch(/IMPORT DONE/);
    expect(await count('client', `name = '${CLIENT}'`)).toBe(1);
    const ev = await migrator.query<{ after: { sha256: string }; actor_user_id: string }>(
      `select after, actor_user_id from audit_event where action = 'import' and after->>'sha256' = $1`,
      [sha],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]?.actor_user_id).toBe(userId);
    expect(
      await count(
        'audit_event',
        `actor_user_id = '${userId}' and action = 'step_up' and table_name = 'import'`,
      ),
    ).toBe(1);
    const again = cli(['--apply', good, '--account', email], PROD);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already imported/);
    expect(await count('client', `name = '${CLIENT}'`)).toBe(1);
    // the report kept in ./.logs/ holds the hash and the counts, not the company's data
    const reports = readdirSync('.logs').filter((f) => f.startsWith('import-apply-'));
    expect(reports.length).toBeGreaterThan(0);
    const text = readFileSync(join('.logs', reports.sort().at(-1)!), 'utf8');
    expect(text).not.toContain(CLIENT);
    // the way back, through the same two checks
    const runId =
      ev.rows[0] &&
      (
        await migrator.query<{ row_id: string }>(
          `select row_id from audit_event where action = 'import' and after->>'sha256' = $1`,
          [sha],
        )
      ).rows[0]!.row_id;
    const phrase = rollbackConfirmation(runId!).phrase;
    const back = cli(['--rollback', runId!, '--account', email], PROD, `${phrase}\n${await nextTotp()}\n`);
    expect(back.code, back.out).toBe(0);
    expect(back.out).toMatch(/ROLLBACK DONE/);
    expect(await count('client', `name = '${CLIENT}' and status = 'archived'`)).toBe(1);
  });
});
