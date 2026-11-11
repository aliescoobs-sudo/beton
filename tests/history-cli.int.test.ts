import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOTP } from '@better-auth/utils/otp';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recreateDatabase, TRAINING_TEST_DATABASE } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import {
  decideLabel,
  decideQuarantine,
  listQuarantine,
  historyConfirmation,
  historyRollbackConfirmation,
  type HistoryMapping,
  listLabels,
  rollbackHistory,
  runHistory,
} from '../src/modules/importer';
import { writeTwin } from '../src/modules/importer/history/twin';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { authSecretCipher } from '../src/modules/platform-security/auth/secret-cipher';
import { testEnv } from './db-env';
import { realActor, realSessionUser } from './helpers/actors';
import { buildWorkbook } from './helpers/xlsx-writer';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';

/**
 * T11 / R18 group 4A: `pnpm import:history` as a child process — the REAL step-up path (typed phrase + authenticator code bound to the operation), driven by a
 * stub authenticator (a synthetic TOTP secret sealed like the real one). Wrong code, replayed code, another operation, another actor, an expired code: apply and
 * rollback refuse and write nothing. Then the whole command on a twin workbook set in TRAINING mode: dry-run, stage, apply, rollback.
 * Synthetic data only (every name says FICTIF).
 */
const env = testEnv();
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
mkdirSync('.logs', { recursive: true });
const dir = mkdtempSync(join('.logs', 'h11-cli-'));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const PROD = { REAL_DATA: 'true', SIMULATION_ENABLED: 'false', TRAINING_MODE: 'false' };

const secrets = new Map<string, string>(); // user id -> synthetic authenticator secret
async function enrol(db: pg.Pool, e: ReturnType<typeof testEnv>, userId: string) {
  const secret = Buffer.from(randomUUID()).toString('hex').slice(0, 20);
  secrets.set(userId, secret);
  await db.query(
    `insert into "twoFactor" (id, secret, "backupCodes", "userId", verified) values ($1, $2, 'f1.unused', $3, true)`,
    [randomUUID(), await authSecretCipher(e).encrypt(secret), userId],
  );
  return secret;
}
/** The stub authenticator counts 30-second steps of the real clock, like the CLI: a sequence that expects "the step already spent" must not straddle a boundary. */
const inFreshStep = async (needMs = 24_000) => {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 500));
};
const stepOf = (offset = 0) => Math.floor(Date.now() / 30_000) + offset;
/** The stub authenticator: the code of a given 30-second step of a user's secret. */
const code = (userId: string, offset = 0): Promise<string> =>
  Promise.resolve(createOTP(secrets.get(userId)!).hotp(stepOf(offset)));

const cli = (e: ReturnType<typeof testEnv>, args: string[], extra: Record<string, string>, input = '') => {
  const r = spawnSync(
    process.execPath,
    ['--import', './scripts/register-ts-paths.mjs', 'scripts/import-history.ts', ...args],
    {
      env: {
        ...process.env,
        DATABASE_URL_APP: e.DATABASE_URL_APP,
        DATABASE_URL_AUTH: e.DATABASE_URL_AUTH,
        ...extra,
      },
      input,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const count = async (db: pg.Pool, sql: string) =>
  Number((await db.query<{ n: string }>(`select count(*)::text n from ${sql}`)).rows[0]!.n);
const written = (db: pg.Pool) =>
  Promise.all(
    ['history.batch', 'history.delivery', 'history.expense', 'history.label_map', 'history.quarantine'].map(
      (t) => count(db, t),
    ),
  );

afterAll(async () => {
  for (const [id] of secrets)
    await migrator.query(`delete from "twoFactor" where "userId" = $1`, [id]).catch(() => undefined);
  await Promise.all([migrator.end(), app.end()]);
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------------------------------------------------
describe('the real step-up path of import:history (production mode, real-shaped files)', () => {
  afterAll(async () => {
    if (plantId)
      await updatePlant(app, await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner'), plantId, {
        status: 'archived',
      });
  });
  let ownerEmail = '';
  let plantCode = '';
  let plantId = '';
  const HEAD = [
    'DATE',
    'CLIENTS',
    'CHANTIERS',
    'M3',
    'TYPE',
    'CAMION',
    'B,L',
    'POMPE',
    'OBSERVATIONS',
    'TRANSPORTEUR',
  ];
  const mapping = (): HistoryMapping => ({
    version: 1,
    kind: 'deliveries',
    plant: 'BELGO',
    plantCode,
    sheet: 'LIVRAISON 1',
    headerRow: 2,
    dateFormat: 'dmy',
    columns: { driver: ['TRANSPORTEUR'], truck: ['CAMION'], bl: ['B,L'] },
    legacyColumns: [],
    blankHeaderField: null,
    includeSheets: [],
    fileMonths: {},
  });
  const mappingFile = () => {
    const f = join(dir, 'mapping.json');
    writeFileSync(f, JSON.stringify(mapping()));
    return f;
  };
  /** A folder with one monthly file of one plant: names are unique to this set. */
  const makeSet = (label: string, withQuarantine = false) => {
    const folder = join(dir, `set-${label}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'F1.xlsx'),
      buildWorkbook([
        {
          name: 'LIVRAISON 1',
          rows: [
            ['', '', '', { f: 'SUM(D3:D9)', v: 0 }],
            HEAD,
            ...(withQuarantine ? [0, 1, 2] : [0, 1]).map((i) => [
              46083 + i,
              `CLT${tag}${label}${i} FICTIF`,
              'CHANTIER FICTIF 1',
              withQuarantine && i === 2 ? '' : 7.5 + i, // no volume: quarantined
              'B25',
              `FX${tag}${label}`,
              100 + i,
              'POMPE',
              'FICTIF',
              `DRV${tag}${label} FICTIF`,
            ]),
          ],
        },
      ]),
    );
    return folder;
  };
  const decisions = (out: string) => {
    const m = /Decisions: ([0-9a-f]{64})/.exec(out);
    if (!m) throw new Error(`no decisions hash in: ${out.slice(0, 600)}`);
    return m[1]!;
  };
  const sha = (out: string) => {
    const m = /set ([0-9a-f]{64})/.exec(out);
    if (!m) throw new Error(`no set hash in: ${out.slice(0, 600)}`);
    return m[1]!;
  };
  /** Stages a set through the command and takes the owner's decisions on its labels (the History screens' service). */
  async function stagedSet(label: string, withQuarantine = false) {
    const folder = makeSet(label, withQuarantine);
    const st = cli(env, ['--stage', folder, '--mapping', mappingFile(), '--account', ownerEmail], PROD);
    expect(st.out).toMatch(/stage|label/i);
    const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
    for (const kind of ['client', 'truck', 'driver', 'type', 'pump'] as const) {
      const { labels } = await listLabels(app, owner, { kind, onlyOpen: true });
      for (const l of labels.filter(
        (x) => x.label.includes('FICTIF') || x.key.includes(tag) || kind === 'type' || kind === 'pump',
      )) {
        const input =
          kind === 'client'
            ? { kind, key: l.key, status: 'label_only' }
            : kind === 'driver'
              ? { kind, key: l.key, status: 'label_only' }
              : { kind, key: l.key, status: 'unknown' };
        await decideLabel(app, owner, input as never);
      }
    }
    let fixedRow = '';
    if (withQuarantine) {
      // the owner fixes the quarantined row (the volume), as the staging screen does
      const open = (await listQuarantine(app, owner, { onlyOpen: true })).filter((q) =>
        (q.raw.client ?? '').includes(`CLT${tag}${label}`),
      );
      expect(open).toHaveLength(1);
      fixedRow = open[0]!.id;
      expect(
        (
          await decideQuarantine(
            app,
            owner,
            { id: fixedRow, action: 'fix', values: { m3: '6' } },
            undefined,
            { trainingMode: false },
          )
        ).ok,
      ).toBe(true);
    }
    const dry = cli(env, ['--dry-run', folder, '--mapping', mappingFile(), '--account', ownerEmail], PROD);
    return {
      folder,
      dry,
      fixedRow,
      owner,
      set: sha(dry.out),
      conf: historyConfirmation(sha(dry.out), decisions(dry.out)),
    };
  }

  beforeAll(async () => {
    ownerEmail = (await operator()).email; // the account that stages (staging needs the account, not a code)
    // a plant of this run (archived at the end: other suites expect no extra active plant)
    plantCode = Array.from({ length: 6 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ).join('');
    const made = await createPlant(app, await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner'), {
      code: plantCode,
      name: `H11 CLI ${tag}`,
    });
    if (!made.ok) throw new Error('plant');
    plantId = made.value.id;
  });

  /** A fresh operator (an app_admin with its own stub authenticator): the failure budget and the one-time step are per account, so each case starts clean. */
  async function operator() {
    const id = uuidv7(realClock.now());
    const email = `op-${id}@kayas.test`;
    await migrator.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
       values ($1, $2, $3, true, 'app_admin', 'fr', 'active', true, now())`,
      [id, `Operator ${tag}`, email],
    );
    await enrol(migrator, env, id);
    return { id, email };
  }
  const applyAs = (email: string, folder: string, input: string) =>
    cli(env, ['--apply', folder, '--mapping', mappingFile(), '--account', email], PROD, input);
  const deniedBy = (id: string) =>
    count(
      migrator,
      `audit_event where actor_user_id = '${id}' and action = 'permission_denied' and table_name = 'import'`,
    );

  /** The real command, run asynchronously so that a test can act while it waits at a prompt. */
  const cliLive = (args: string[]) => {
    const child = spawn(
      process.execPath,
      ['--import', './scripts/register-ts-paths.mjs', 'scripts/import-history.ts', ...args],
      {
        env: {
          ...process.env,
          DATABASE_URL_APP: env.DATABASE_URL_APP,
          DATABASE_URL_AUTH: env.DATABASE_URL_AUTH,
          ...PROD,
        },
      },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const until = async (needle: string) => {
      for (let i = 0; i < 1200; i++) {
        if (out.includes(needle)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`never printed: ${needle}\n${out.slice(-800)}`);
    };
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    return { send: (t: string) => child.stdin.write(t), until, done, out: () => out };
  };

  it.each([
    ['a label mapping', 'label'],
    ['a corrected row', 'row'],
  ] as const)(
    'R19-07: %s changed from another actor while the real CLI waits for the authenticator code: the apply is refused and nothing is written',
    async (_n, what) => {
      const op = await operator();
      const a = await stagedSet(`R${Math.floor(Math.random() * 1e4)}`, true);
      await inFreshStep();
      const before = await written(migrator);
      const live = cliLive(['--apply', a.folder, '--mapping', mappingFile(), '--account', op.email]);
      await live.until('to apply:');
      live.send(`${a.conf.phrase}\n`);
      await live.until('Authenticator code'); // paused at the second factor
      if (what === 'label') {
        const { labels } = await listLabels(app, a.owner, { kind: 'client' });
        const mine = labels.find((l) => l.key.includes(`CLT${tag}`) && l.status === 'label_only');
        expect(mine, 'a decided client label of this set').toBeTruthy();
        expect(
          (await decideLabel(app, a.owner, { kind: 'client', key: mine!.key, status: 'new' } as never)).ok,
        ).toBe(true);
      } else {
        expect(
          (
            await decideQuarantine(
              app,
              a.owner,
              { id: a.fixedRow, action: 'fix', values: { m3: '9' } },
              undefined,
              { trainingMode: false },
            )
          ).ok,
        ).toBe(true);
      }
      live.send(`${await code(op.id)}\n`);
      expect(await live.done).toBe(1);
      expect(live.out()).toMatch(/staging decisions .* changed after the confirmation/);
      expect(await written(migrator)).toEqual(before.map((n, i) => (i === 3 && what === 'label' ? n : n))); // no batch applied, no history rows
      expect(await count(migrator, `history.batch where status = 'applied' and set_sha = '${a.set}'`)).toBe(
        0,
      );
    },
  );

  it('control: with the decisions unchanged the same flow applies', async () => {
    const op = await operator();
    const a = await stagedSet(`K${Math.floor(Math.random() * 1e4)}`, true);
    await inFreshStep();
    const live = cliLive(['--apply', a.folder, '--mapping', mappingFile(), '--account', op.email]);
    await live.until('to apply:');
    live.send(`${a.conf.phrase}\n`);
    await live.until('Authenticator code');
    live.send(`${await code(op.id)}\n`);
    expect(await live.done).toBe(0);
    expect(await count(migrator, `history.batch where status = 'applied' and set_sha = '${a.set}'`)).toBe(1);
  });

  it('the typed phrase of ANOTHER set writes nothing', async () => {
    const op = await operator();
    const a = await stagedSet('PH');
    const before = await written(migrator);
    const r = applyAs(
      op.email,
      a.folder,
      `${historyConfirmation('0'.repeat(64), '0'.repeat(64)).phrase}\n${await code(op.id)}\n`,
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Confirmation not typed/);
    expect(await written(migrator)).toEqual(before);
  });

  it.each([
    ['three wrong codes', 'wrong'],
    ["the authenticator code of ANOTHER actor (a real code, another account's secret)", 'other'],
    ['an EXPIRED code (four 30-second steps old), three times', 'expired'],
  ] as const)('%s: apply writes nothing and the failures are audited', async (_n, how) => {
    const op = await operator();
    const stranger = await operator();
    const a = await stagedSet(`W${Math.floor(Math.random() * 1e4)}`);
    const before = await written(migrator);
    const codes =
      how === 'wrong'
        ? '000000\n111111\n222222\n'
        : how === 'other'
          ? `${await code(stranger.id)}\n${await code(stranger.id, -1)}\n${await code(stranger.id, 1)}\n`
          : `${await code(op.id, -4)}\n${await code(op.id, -5)}\n${await code(op.id, -6)}\n`;
    const r = applyAs(op.email, a.folder, `${a.conf.phrase}\n${codes}`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Second factor not given|account is locked/);
    expect(await written(migrator)).toEqual(before);
    expect(await deniedBy(op.id)).toBeGreaterThanOrEqual(3);
  });

  it("a good code applies once; the SAME code replayed for another set is refused and writes nothing; a later step's code works", async () => {
    const op = await operator();
    const first = await stagedSet('RA');
    const second = await stagedSet('RB');
    const before = await written(migrator);
    const applied0 = await count(migrator, `history.batch where status = 'applied'`);
    await inFreshStep();
    const used = await code(op.id, 0);
    const ok = applyAs(op.email, first.folder, `${first.conf.phrase}\n${used}\n`);
    expect(ok.code, ok.out).toBe(0);
    const mid = await written(migrator);
    expect(mid[0]).toBe(before[0]!); // the staged batch moved forward; no second batch
    expect(await count(migrator, `history.batch where status = 'applied'`)).toBe(applied0 + 1);
    expect(
      await count(
        migrator,
        `audit_event where actor_user_id = '${op.id}' and action = 'step_up' and table_name = 'import'`,
      ),
    ).toBe(1);
    // the replay: the very code that was just used, for the second set
    const replay = applyAs(op.email, second.folder, `${second.conf.phrase}\n${used}\n`);
    expect(replay.code).toBe(1);
    expect(replay.out).toMatch(/Wrong code|Second factor not given|locked/);
    expect(await written(migrator)).toEqual(mid);
    // the next step's code is a new claim: it applies the second set
    const next = applyAs(op.email, second.folder, `${second.conf.phrase}\n${await code(op.id, 1)}\n`);
    expect(next.code, next.out).toBe(0);
    expect(await count(migrator, `history.batch where status = 'applied'`)).toBe(applied0 + 2);
  });

  it('the proof is bound to its operation at the service: the proof of one set applies no other, and the proof of an apply rolls nothing back; the CLI rollback refuses a wrong phrase or code and leaves the batch applied', async () => {
    const op = await operator();
    const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
    const a = await stagedSet('OP');
    const b = await stagedSet('OQ');
    const proofOfB = b.conf.operation;
    const env0 = { trainingMode: false, realData: true, simulationEnabled: false };
    const before = await written(migrator);
    const refused = await runHistory({
      appPool: app,
      actor: { ...owner, stepUpVerified: true },
      files: (await import('../scripts/import-history-lib')).listInputFiles(a.folder),
      mapping: mapping(),
      environment: env0,
      mode: 'apply',
      stepUp: { userId: owner.id, operation: proofOfB },
    }).then(
      (r) => r.applied,
      (e: Error) => `refused: ${e.message}`,
    );
    expect(refused).not.toBe(true);
    expect(await written(migrator)).toEqual(before);
    // apply set A properly through the command, then try to roll it back with the apply's proof
    await inFreshStep(28_000); // the apply below spends the step that the replay further down expects to be spent
    const ok = applyAs(op.email, a.folder, `${a.conf.phrase}\n${await code(op.id, 0)}\n`);
    expect(ok.code, ok.out).toBe(0);
    const batch = (
      await migrator.query<{ id: string }>(
        `select id from history.batch where status = 'applied' order by created_at desc limit 1`,
      )
    ).rows[0]!.id;
    const rb = await rollbackHistory({
      appPool: app,
      actor: { ...owner, stepUpVerified: true },
      batchId: batch,
      environment: env0,
      stepUp: { userId: owner.id, operation: a.conf.operation },
    }).then(
      () => 'rolled back',
      (e: Error) => `refused: ${e.message}`,
    );
    expect(rb).toMatch(/^refused/);
    expect(await count(migrator, `history.batch where id = '${batch}' and status = 'applied'`)).toBe(1);
    // the command: a wrong typed phrase, then a replayed code, leave it applied; the next step's code rolls it back
    const phrase = historyRollbackConfirmation(batch).phrase;
    const back = (input: string) => cli(env, ['--rollback', batch, '--account', op.email], PROD, input);
    expect(back('ROLLBACK 000000\n').out).toMatch(/Confirmation not typed/);
    expect(back(`${phrase}\n${await code(op.id, 0)}\n`).code).toBe(1); // the step of the apply is spent
    expect(await count(migrator, `history.batch where id = '${batch}' and status = 'applied'`)).toBe(1);
    const done = back(`${phrase}\n${await code(op.id, 1)}\n`);
    expect(done.code, done.out).toBe(0);
    expect(await count(migrator, `history.batch where id = '${batch}' and status = 'rolled_back'`)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------
describe('the whole command on a twin workbook set, TRAINING mode, on a scratch database that carries the training marker', () => {
  const DB = TRAINING_TEST_DATABASE; // a database the bootstrap may drop; the training suites use it one after the other (files run serially)
  const scratch = testEnv(DB);
  const TRAINING = { REAL_DATA: 'false', SIMULATION_ENABLED: 'false', TRAINING_MODE: 'true' };
  let sMigrator: pg.Pool;
  let sApp: pg.Pool;
  let email = '';
  let userId = '';
  const folder = join(dir, 'twin');
  const mapFile = join(folder, 'mapping', 'deliveries-tetouan.json');
  const ownerSession = async () => realSessionUser(scratch.DATABASE_URL_MIGRATOR, 'owner');

  beforeAll(async () => {
    await recreateDatabase(env, DB);
    await runMigrations(scratch.DATABASE_URL_MIGRATOR);
    sMigrator = new pg.Pool({ connectionString: scratch.DATABASE_URL_MIGRATOR, max: 2 });
    sApp = new pg.Pool({ connectionString: scratch.DATABASE_URL_APP, max: 2 });
    userId = uuidv7(realClock.now());
    email = `owner-${userId}@kayas.test`;
    await sMigrator.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
       values ($1, 'Owner FICTIF', $2, true, 'owner', 'fr', 'active', true, now())`,
      [userId, email],
    );
    await enrol(sMigrator, scratch, userId);
    await sMigrator.query('insert into public.training_marker default values'); // it is a training database
    const owner = await ownerSession();
    for (const [code_, name] of [
      ['TETOUAN', 'Tétouan FICTIF'],
      ['CHEFCHN', 'Chefchaouen FICTIF'],
    ] as const) {
      const r = await createPlant(sApp, owner, { code: code_, name });
      if (!r.ok) throw new Error(`plant ${code_}`);
    }
    writeTwin(folder, { seed: 7, belgoRows: 24, chaounRows: 12, belgoClients: 5, chaounClients: 3 });
  }, 120_000);
  afterAll(async () => {
    await Promise.all([sMigrator?.end(), sApp?.end()]);
  });

  it('dry-run writes nothing; stage writes only staging; apply needs the typed phrase and a fresh code; rollback the same; nothing reaches live tables', async () => {
    const tetouanDir = join(folder, 'tetouan');
    const dry = cli(scratch, ['--dry-run', tetouanDir, '--mapping', mapFile, '--account', email], TRAINING);
    expect(dry.out, dry.out).toMatch(/dry|DRY|read/i);
    expect(await count(sMigrator, 'history.batch')).toBe(0);
    expect(await count(sMigrator, 'history.label_map')).toBe(0);
    const live0 = await Promise.all(
      ['stock_movement', 'invoice', 'delivery', 'sales_order', 'trip_plan'].map((t) => count(sMigrator, t)),
    );
    const staged = cli(scratch, ['--stage', tetouanDir, '--mapping', mapFile, '--account', email], TRAINING);
    expect(staged.out, staged.out).not.toMatch(/ENVIRONMENT|refused/i);
    expect(await count(sMigrator, 'history.batch')).toBe(1);
    expect(await count(sMigrator, 'history.label_map')).toBeGreaterThan(0);
    expect(await count(sMigrator, 'history.delivery')).toBe(0); // staging only
    // the owner decides the open labels (the History screens' service), then the command applies
    const owner = await ownerSession();
    for (const kind of ['client', 'truck', 'driver', 'type', 'pump'] as const) {
      const { labels } = await listLabels(sApp, owner, { kind, onlyOpen: true });
      for (const l of labels) {
        const input =
          kind === 'client'
            ? { kind, key: l.key, status: 'new' }
            : kind === 'driver'
              ? { kind, key: l.key, status: 'label_only' }
              : { kind, key: l.key, status: 'unknown' };
        await decideLabel(sApp, owner, input as never);
      }
    }
    for (const q of await listQuarantine(sApp, owner, { onlyOpen: true }))
      await decideQuarantine(sApp, owner, { id: q.id, action: 'discard' });
    const peek = cli(scratch, ['--dry-run', tetouanDir, '--mapping', mapFile, '--account', email], TRAINING);
    const setSha = sha2(peek.out);
    const twinConf = historyConfirmation(setSha, /Decisions: ([0-9a-f]{64})/.exec(peek.out)![1]!);
    await inFreshStep();
    // a wrong phrase and a wrong code write nothing
    expect(
      cli(
        scratch,
        ['--apply', tetouanDir, '--mapping', mapFile, '--account', email],
        TRAINING,
        'HISTORY 000000000000\n',
      ).out,
    ).toMatch(/Confirmation not typed/);
    expect(
      cli(
        scratch,
        ['--apply', tetouanDir, '--mapping', mapFile, '--account', email],
        TRAINING,
        `${twinConf.phrase}\n000000\n000001\n000002\n`,
      ).out,
    ).toMatch(/Second factor not given/);
    expect(await count(sMigrator, 'history.delivery')).toBe(0);
    const ok = cli(
      scratch,
      ['--apply', tetouanDir, '--mapping', mapFile, '--account', email],
      TRAINING,
      `${twinConf.phrase}\n${await code(userId, -1)}\n`,
    );
    expect(ok.code, ok.out).toBe(0);
    expect(await count(sMigrator, `history.batch where status = 'applied'`)).toBe(1);
    expect(await count(sMigrator, 'history.delivery')).toBeGreaterThan(0);
    // history is its own layer: no live table moved
    expect(
      await Promise.all(
        ['stock_movement', 'invoice', 'delivery', 'sales_order', 'trip_plan'].map((t) => count(sMigrator, t)),
      ),
    ).toEqual(live0);
    // the same set again: already applied, nothing done
    // (applying moved the mappings' state, so the decisions hash is a new one: the phrase is read from a fresh dry-run, as an operator would)
    const peek2 = cli(scratch, ['--dry-run', tetouanDir, '--mapping', mapFile, '--account', email], TRAINING);
    const twinConf2 = historyConfirmation(setSha, /Decisions: ([0-9a-f]{64})/.exec(peek2.out)![1]!);
    const again = cli(
      scratch,
      ['--apply', tetouanDir, '--mapping', mapFile, '--account', email],
      TRAINING,
      `${twinConf2.phrase}\n${await code(userId, 0)}\n`,
    );
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/Already applied/);
    expect(await count(sMigrator, `history.batch where status = 'applied'`)).toBe(1);
    // rollback: refused with a wrong phrase / the replayed code, done with the next step's code; the rows stay, the batch is marked
    const batch = (
      await sMigrator.query<{ id: string }>(`select id from history.batch where status = 'applied'`)
    ).rows[0]!.id;
    const rb = historyRollbackConfirmation(batch);
    expect(
      cli(scratch, ['--rollback', batch, '--account', email], TRAINING, 'ROLLBACK 000000\n').out,
    ).toMatch(/Confirmation not typed/);
    expect(
      cli(
        scratch,
        ['--rollback', batch, '--account', email],
        TRAINING,
        `${rb.phrase}\n${await code(userId, 0)}\n`, // the step already spent by the re-apply
      ).out,
    ).toMatch(/Second factor not given|locked/);
    expect(await count(sMigrator, `history.batch where id = '${batch}' and status = 'applied'`)).toBe(1);
    const done = cli(
      scratch,
      ['--rollback', batch, '--account', email],
      TRAINING,
      `${rb.phrase}\n${await code(userId, 1)}\n`,
    );
    expect(done.code, done.out).toBe(0);
    expect(await count(sMigrator, `history.batch where id = '${batch}' and status = 'rolled_back'`)).toBe(1);
    expect(await count(sMigrator, 'history.delivery')).toBeGreaterThan(0); // never deleted
    // a real-shaped (marker-free) file is refused in training mode
    const real = join(dir, 'real-shaped');
    mkdirSync(real, { recursive: true });
    writeFileSync(
      join(real, 'F1.xlsx'),
      buildWorkbook([{ name: 'LIVRAISON 1', rows: [['x'], ['DATE'], [46083]] }]),
    );
    const refused = cli(scratch, ['--dry-run', real, '--mapping', mapFile, '--account', email], TRAINING);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toMatch(/twin|training|marker/i);
  }, 240_000);
});
const expectOut = (r: { out: string }) => expect(r.out, r.out);
const sha2 = (out: string) => /set ([0-9a-f]{64})/.exec(out)![1]!;
