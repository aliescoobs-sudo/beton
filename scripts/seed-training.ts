// The training instance's data (T1): two plants, fictitious parties with obviously fake identifiers, trucks and pumps, recipes and
// reference prices per plant, orders, purchases, receipts, transfers, cheques and payments in every state, and one account per role.
// Fictitious data only. Refuses unless TRAINING_MODE=true and APP_ENV is not production; writes a marker so the server knows this
// database is a training database. Credentials are generated once and written to the file named by TRAINING_ACCOUNTS_FILE (required, no
// default: a private folder outside any checkout or build context; in the containers /app/out/training-accounts.local.txt); never printed.
//   corepack pnpm seed:training         (an already seeded database is left alone: use `reset:training`)
import { assertNoUsableReservedAccounts } from '../src/modules/platform-security/service/reserved-admission.ts';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { realClock } from '../src/modules/clock/index.ts';
import { inRequest } from '../src/modules/platform-security/index.ts';
import type { Env } from '../src/lib/env.ts';
import { seedPilotScenario } from '../src/modules/ledger/service/pilot-scenario.ts';
import { createPurchase } from '../src/modules/ledger/index.ts';
import { createOrder } from '../src/modules/ledger/index.ts';
import {
  createClient,
  createListPrice,
  createPlant,
  createRecetteVersion,
  createSupplier,
  createTruck,
  listComponents,
  listConcreteTypes,
  listTrucks,
  seedPilotMasterData,
  updateTruck,
} from '../src/modules/master-data/index.ts';
import { executeFinance } from '../src/modules/finance/index.ts';
import { createFieldAccount, setDriverPin } from '../src/modules/field/index.ts';
import {
  confirmArrivalAtPlant,
  pickUpTransfer,
  schedulePumpJob,
  sendTransfer,
  setFuelTankOpening,
  setOpeningStock,
  setOrderPumped,
} from '../src/modules/operations/index.ts';
import { armTrainingDay } from './training-day.ts';
import {
  PROVENANCE_REFUSAL,
  claimBirthToken,
  hasBirthToken,
  databaseNameOf,
  isTestRunnerDatabase,
} from './training-birth.ts';
import { seedIntegrationScenario } from '../src/modules/operations/service/pilot-integration.ts';
import { seedOperationsScenario } from '../src/modules/operations/service/pilot-ops.ts';
import { seedOperationsWave2 } from '../src/modules/operations/service/pilot-ops2.ts';
import { BOOTSTRAP_ACTOR_ID, createAuth, createUser } from '../src/modules/platform-security/index.ts';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate.ts';
import { fieldCipherFrom } from '../src/modules/master-data/index.ts';
import { parseKeyring } from '../src/lib/crypto/keyring.ts';
import {
  type IssuedCredential,
  PASSWORD_ACCOUNTS,
  emailOf,
  generatePassword,
  generatePin,
  acquireSeedLock,
  publishCredentials,
  renderCredentialsFile,
  stageCredentialsFile,
  SeedLockError,
  type SeedLock,
  sweepStaleStagedCredentials,
  type StagedCredentials,
  validateCredentialsPath,
} from './training-lib.ts';

export interface SeedTrainingOptions {
  env: Env & { DATABASE_URL_SEED: string; DATABASE_URL_MIGRATOR: string };
  /** The business date the data are dated from (the real date when absent). */
  today: string;
  credentialsFile: string;
  /**
   * R13-01: 'stock-volume' (the default) requires and consumes the birth token of the stack's database-initialisation step.
   * 'unverified-test-database' skips it, and is honoured ONLY for the throwaway databases of the test runners.
   */
  provenance?: 'stock-volume' | 'unverified-test-database';
}
export interface SeedTrainingResult {
  applied: boolean;
  accounts: number;
  credentialsFile: string | null;
}

class SeedError extends Error {}
function must<T>(label: string, r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new SeedError(`training seed: ${label} failed (${r.error})`);
  return r.value;
}
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const session = (u: {
  id: string;
  name: string;
  email: string;
  role: string;
  plantId?: string | null;
}): SessionUser =>
  ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    locale: 'fr',
    twoFactorEnabled: false,
    reenrolRequired: false,
    stepUpVerified: true, // the seed stands for requests that passed the step-up
    ...(u.plantId ? { plantId: u.plantId } : {}),
  }) as unknown as SessionUser;

/**
 * R11-02: the seed writes only into a database that is EMPTY of business records and unmarked. A database that already holds
 * accounts, parties, orders, trucks or invoices is somebody's data (or a half-finished seed): refused before the first write, with
 * the way out (a fresh database). The marker is written last, only once everything else, the credentials file included, is done.
 */
/**
 * Tables the migrations themselves fill with reference data, as `schema.table`. A fresh database after every migration holds NO row in
 * any table of `public` or `finance` (checked when this was written), so the list is empty; a migration that starts seeding a table adds
 * it here on purpose. Everything else must be empty.
 */
export const SEED_REFERENCE_TABLES: readonly string[] = [];

/**
 * R12-01, R13-01: the whole business state, with an exact proof of emptiness, never an estimate. Every table of `public` and `finance` is
 * listed from the catalog (so a table added tomorrow is covered the day it exists) and must be empty unless it is on the reference
 * allowlist. A table is accepted as empty only by one of two exact proofs:
 *   1. its heap file has size 0: no page was ever written, so no row ever existed (the size is metadata that row-level security cannot
 *      filter, and no statistic is involved); or
 *   2. an exact read returns no row AND the maintenance login is not subject to a row-level policy on that table (not enabled, or it
 *      owns the table without FORCE, or it bypasses). A table whose rows this login may not fully see FAILS CLOSED: it counts as
 *      "cannot be shown empty", it is never read as zero.
 * `pg_stat` estimates (n_live_tup) are not consulted. No read policy and no BYPASSRLS is granted to anybody for this. The refusal names
 * tables only, never a row.
 */
export async function assertSeedTargetEmpty(migrator: pg.Pool): Promise<void> {
  const { rows: tables } = await migrator.query<{
    schema: string;
    name: string;
    empty_file: boolean;
    filtered: boolean;
  }>(
    `select n.nspname as schema, c.relname as name,
            (c.relkind = 'p' or pg_relation_size(c.oid, 'main') = 0) as empty_file,
            (c.relrowsecurity
               and not (select r.rolbypassrls from pg_roles r where r.rolname = current_user)
               and not (c.relowner = (select r.oid from pg_roles r where r.rolname = current_user) and not c.relforcerowsecurity)
            ) as filtered
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname in ('public', 'finance')
      order by 1, 2`,
  );
  const holding: string[] = [];
  const unprovable: string[] = [];
  for (const t of tables) {
    const full = `${t.schema}.${t.name}`;
    if (SEED_REFERENCE_TABLES.includes(full)) continue;
    if (t.empty_file) continue; // proof 1: nothing was ever written
    let visible: number | null = 1;
    try {
      visible = (
        await migrator.query(`select 1 from ${pgFormatIdent(t.schema)}.${pgFormatIdent(t.name)} limit 1`)
      ).rowCount;
    } catch (error) {
      if ((error as { code?: string }).code !== '42501') throw error;
    }
    if (visible) holding.push(full);
    else if (t.filtered) unprovable.push(full); // proof 2 impossible: rows could be hidden from this login
  }
  if (holding.length)
    throw new SeedError(
      `training seed refused: this database is not empty (${holding.join(', ')} hold rows) and carries no training marker. ` +
        'The training seed only fills a fresh database: remove the training database volume and start again (docker compose down -v), ' +
        'never point training at an existing database.',
    );
  if (unprovable.length)
    throw new SeedError(
      `training seed refused: emptiness cannot be proven for ${unprovable.join(', ')} (the tables have been written to, and row-level security may hide their rows from the maintenance login). ` +
        'Fresh state only: remove the training database volume and start again (docker compose down -v).',
    );
}

const pgFormatIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export async function seedTraining(opts: SeedTrainingOptions): Promise<SeedTrainingResult> {
  const { env, today } = opts;
  if (!env.TRAINING_MODE) throw new SeedError('training seed refused: TRAINING_MODE is not "true"');
  if (env.APP_ENV === 'production') throw new SeedError('training seed refused: APP_ENV is "production"');
  if (env.REAL_DATA) throw new SeedError('training seed refused: REAL_DATA is "true"');

  const needToken = opts.provenance !== 'unverified-test-database';
  if (!needToken && !isTestRunnerDatabase(env.DATABASE_URL_MIGRATOR))
    throw new SeedError(
      'training seed refused: the provenance check can only be skipped on a test-runner database',
    );

  const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
  const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
  const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
  const seed = new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 2 });
  const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
  let lock: SeedLock | undefined;
  try {
    // R11-04 / R13: a destination that cannot be trusted is found before anything else, and a staged file left by an earlier crash
    // (a half-seed that was interrupted, or a seeded database that is being asked again) is removed FIRST, whatever the checks below say.
    validateCredentialsPath(opts.credentialsFile);
    // R14-12: the whole seed/output lifecycle is under one lock, taken BEFORE the sweep and held to the end. A second seed that finds the
    // lock live is refused before it sweeps, claims the token or writes anything; the sweep only removes stages of superseded attempts (R15A-05).
    lock = acquireSeedLock(opts.credentialsFile);
    const swept = sweepStaleStagedCredentials(opts.credentialsFile, lock);
    if (swept.unknown.length)
      console.warn(
        `training seed: ${swept.unknown.length} staged credentials file(s) of an unknown earlier attempt were left in place (${swept.unknown.join(', ')}). Nothing proves that no seed can still rename them: remove them by hand once you know no seed is running.`,
      );
    if ((await migrator.query('select 1 from public.training_marker')).rowCount)
      return { applied: false, accounts: 0, credentialsFile: null };
    await assertSeedTargetEmpty(migrator);
    await assertNoUsableReservedAccounts(migrator);
    // R13-01: provenance. Checked (without being consumed) before the first write; consumed right after the destination is vetted.
    const database = databaseNameOf(env.DATABASE_URL_MIGRATOR);
    if (needToken && !(await hasBirthToken(env, database))) throw new SeedError(PROVENANCE_REFUSAL);
    // Claimed atomically: two seeds cannot both pass, and one seed cannot be run twice on the same volume.
    // R15A-05: every commit below is preceded by a check that this attempt still holds the lock (a stalled seed that another one has
    // taken over from stops here instead of finishing over the newer one).
    lock.assertHeld('the claim of the birth token');
    if (needToken && !(await claimBirthToken(env, database))) throw new SeedError(PROVENANCE_REFUSAL);

    const issued: IssuedCredential[] = [];
    const cipher = fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS));
    const auth = createAuth({ authPool, env });

    // 1. Master data (components, concrete types, zones, parties, trucks, recipes, prices): the pilot's fictitious base.
    await seedPilotMasterData(seed, env);

    // 2. Accounts with a password (the owner first: it creates the rest).
    const created = new Map<string, { id: string; session: SessionUser }>();
    const makeAccount = async (a: (typeof PASSWORD_ACCOUNTS)[number], plantId: string | null) => {
      const password = generatePassword();
      const email = emailOf(a.login);
      const { id } = await createUser(auth, authPool, {
        actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
        email,
        name: a.name,
        password,
        role: a.role as never,
        locale: a.locale,
        plantId,
      });
      issued.push({ label: a.label, role: a.role, login: email, secret: password, secretKind: 'password' });
      created.set(a.login, { id, session: session({ id, name: a.name, email, role: a.role, plantId }) });
    };
    await makeAccount(PASSWORD_ACCOUNTS[0]!, null);
    const owner = created.get('proprietaire')!.session;

    // 3. Plant Tétouan, and its four 16 m³ trucks, before the pilot scenario so that everything it writes belongs to it.
    const tet = must(
      'plant Tétouan',
      await createPlant(app, owner, { code: 'TETOUAN', name: 'Centrale de Tétouan' }),
    );
    const pilotTrucks = await listTrucks(app, owner);
    for (const t of pilotTrucks.filter((x) => x.kind === 'mixer').slice(0, 4))
      must(
        `truck ${t.code}`,
        await updateTruck(app, owner, t.id, { plate: t.plate, capacityL: 16_000, plantId: tet.id }),
      );

    // 4. The pilot scenario (orders, cheques, LCN, instalments, loads, rotations, invoices, supplier invoices) dated from today.
    await seedPilotScenario(seed, env, today);
    await seedOperationsScenario(seed, env, today);
    await seedOperationsWave2(seed, env, today);
    await seedIntegrationScenario(seed, env, today);

    // 5. Plant Chefchaouen, with its own trucks, pumps, recipes, reference prices, stock and activity.
    const chf = must(
      'plant Chefchaouen',
      await createPlant(app, owner, { code: 'CHEFCHN', name: 'Centrale de Chefchaouen' }),
    );
    const inChf = { ...owner, plantId: chf.id } as SessionUser;
    const inTet = { ...owner, plantId: tet.id } as SessionUser;
    for (let i = 0; i < 4; i++)
      must(
        `truck T${5 + i}`,
        await createTruck(app, owner, {
          code: `T${5 + i}`,
          plate: `20${i + 1}01-D-6`,
          capacityL: 11_000,
          plantId: chf.id,
        }),
      );
    must(
      'truck T9',
      await createTruck(app, owner, { code: 'T9', plate: '20109-D-6', capacityL: 10_000, plantId: chf.id }),
    );
    const pumpIds: string[] = [];
    for (let i = 1; i <= 3; i++)
      pumpIds.push(
        must(
          `pump P${i}`,
          await createTruck(app, owner, { code: `P${i}`, plate: `POMPE-DEMO-${i}`, kind: 'pump' }),
        ).id,
      );

    const types = await listConcreteTypes(app, owner);
    const typeId = (code: string) => types.find((t) => t.code === code)!.id;
    const components = await listComponents(app, owner);
    const comp = (nameFr: string) => components.find((c) => c.nameFr === nameFr)!;

    // Recipes per plant (different mixes) and the reference prices per plant.
    const mix = (c: number, s: number, g1: number, g2: number, w: number, a: number) => [
      { componentId: comp('Ciment').id, qtyPerM3: c },
      { componentId: comp('Sable').id, qtyPerM3: s },
      { componentId: comp('Gravette 8/15').id, qtyPerM3: g1 },
      { componentId: comp('Gravette 15/25').id, qtyPerM3: g2 },
      { componentId: comp('Eau').id, qtyPerM3: w },
      { componentId: comp('Adjuvant').id, qtyPerM3: a },
    ];
    must(
      'recipe B25 Chefchaouen',
      await createRecetteVersion(app, owner, typeId('B25'), {
        plantId: chf.id,
        effectiveFrom: '2026-01-02',
        lines: mix(335_000, 830_000, 380_000, 610_000, 182, 3_200),
      }),
    );
    must(
      'recipe B30 Tétouan',
      await createRecetteVersion(app, owner, typeId('B30'), {
        plantId: tet.id,
        effectiveFrom: '2026-01-02',
        lines: mix(415_000, 770_000, 380_000, 570_000, 172, 4_200),
      }),
    );
    for (const [code, centimes] of [
      ['B20', 80_000],
      ['B25', 87_000],
      ['B30', 95_000],
    ] as const)
      must(
        `price ${code} Chefchaouen`,
        await createListPrice(app, owner, {
          concreteTypeId: typeId(code),
          plantId: chf.id,
          priceHtPerM3Centimes: centimes,
          effectiveFrom: '2026-01-02',
        }),
      );
    must(
      'price B25 Tétouan',
      await createListPrice(app, owner, {
        concreteTypeId: typeId('B25'),
        plantId: tet.id,
        priceHtPerM3Centimes: 86_000,
        effectiveFrom: '2026-01-02',
      }),
    );

    // Obviously fictitious parties: fake ICE, fake phones that cannot be dialled (0000 00 xxxx: 00 is the international prefix and no country code starts with 0).
    const supplierCement = must(
      'supplier Ciment Démo',
      await createSupplier(app, owner, {
        name: 'Ciment Démo',
        category: 'cement',
        ice: '000000000000101',
        phone: '0000 00 0101',
        paymentTermsDays: 30,
        leadTimeDays: 3,
      }),
    );
    must(
      'supplier Carburant Démo',
      await createSupplier(app, owner, {
        name: 'Carburant Démo',
        category: 'fuel',
        ice: '000000000000102',
        phone: '0000 00 0102',
        paymentTermsDays: 15,
        leadTimeDays: 1,
      }),
    );
    const clients = [];
    for (let i = 1; i <= 4; i++) {
      const r = must(
        `client ${i}`,
        await createClient(app, owner, {
          name: `Client Démo ${i}`,
          kind: 'company',
          ice: `00000000000020${i}`,
          phone: `0000 00 000${i}`,
          paymentTermsDays: 30,
        }),
      );
      clients.push(r.client);
    }

    // Stock and fuel of Chefchaouen, a purchase received in two states, a transfer between the plants.
    const opening = addDays(today, -30);
    for (const [name, qty] of [
      ['Ciment', 60_000_000],
      ['Sable', 150_000_000],
      ['Gravette 8/15', 90_000_000],
      ['Gravette 15/25', 90_000_000],
      ['Eau', 40_000],
      ['Adjuvant', 400_000],
    ] as const)
      must(
        `opening ${name}`,
        await setOpeningStock(app, owner, {
          componentId: comp(name).id,
          date: opening,
          qtyBase: qty,
          plantId: chf.id,
        }),
      );
    must(
      'fuel Chefchaouen',
      await setFuelTankOpening(app, owner, { plantId: chf.id, litres: 3_000, asOf: opening }),
    );
    must(
      'fuel Tétouan',
      await setFuelTankOpening(app, owner, { plantId: tet.id, litres: 5_000, asOf: opening }),
    );

    const purchase = must(
      'purchase Chefchaouen',
      await createPurchase(
        app,
        inChf,
        {
          supplierId: supplierCement.id,
          plantId: chf.id,
          lines: [
            {
              componentId: comp('Ciment').id,
              purchaseUnitId: await unitOf(app, owner, comp('Ciment').id, 't'),
              qtyMilli: 20_000,
              unitPriceHtCentimes: 145_000,
            },
          ],
        },
        { today },
      ),
    );

    // 6. The remaining accounts (the plant managers need both plants).
    for (const a of PASSWORD_ACCOUNTS.slice(1))
      await makeAccount(a, a.plant === 'TET' ? tet.id : a.plant === 'CHF' ? chf.id : null);

    // 7. Phone accounts: three drivers of the pilot's rotations and a pump operator, each with a code and a PIN.
    const deps = { appPool: app, authPool, auth, secret: env.AUTH_SECRET };
    const driverRows = await listDrivers(app, owner);
    for (const d of driverRows.filter((x) => x.kind === 'driver').slice(0, 3)) {
      must(`field account ${d.code}`, await createFieldAccount(deps, owner, d.id));
      const pin = generatePin();
      must(`pin ${d.code}`, await setDriverPin(deps, owner, { driverId: d.id, pin }));
      issued.push({
        label: `Chauffeur ${d.name}`,
        role: 'driver',
        login: d.code,
        secret: pin,
        secretKind: 'pin',
      });
    }
    const operator = await addPumpOperator(app, owner, 'Pompiste Démo');
    must('field account pump operator', await createFieldAccount(deps, owner, operator.id));
    const operatorPin = generatePin();
    must('pin pump operator', await setDriverPin(deps, owner, { driverId: operator.id, pin: operatorPin }));
    issued.push({
      label: 'Pompiste Démo',
      role: 'pump_operator',
      login: operator.code,
      secret: operatorPin,
      secretKind: 'pin',
    });

    // 8. Activity at Chefchaouen: orders (one pumped with a pump on site, one waiting for a price), a counted arrival with a refused part,
    //    a material and a fuel transfer from Tétouan.
    const c1 = clients[0]!;
    const c2 = clients[1]!;
    const tomorrow = addDays(today, 1);
    must(
      'order Chefchaouen A',
      await createOrder(
        app,
        inChf,
        {
          clientId: c1.id,
          plantId: chf.id,
          concreteTypeId: typeId('B25'),
          dischargeMethod: 'POMPE',
          volumeL: 22_000,
          deliveryDate: tomorrow,
          plan: { preset: 'advance50' },
        },
        { today },
      ),
    );
    const orderB = must(
      'order Chefchaouen B',
      await createOrder(
        app,
        inChf,
        {
          clientId: c2.id,
          plantId: chf.id,
          concreteTypeId: typeId('B30'),
          dischargeMethod: 'GOULOTTE',
          volumeL: 11_000,
          deliveryDate: today,
          plan: { preset: 'cash' },
        },
        { today },
      ),
    );
    must(
      'order Tétouan C',
      await createOrder(
        app,
        inTet,
        {
          clientId: c1.id,
          plantId: tet.id,
          concreteTypeId: typeId('B20'),
          dischargeMethod: 'GOULOTTE',
          volumeL: 32_000,
          deliveryDate: tomorrow,
          plan: { preset: 'cheque30' },
        },
        { today },
      ),
    );
    const orderBId = orderB.id;
    must('order B pumped', await setOrderPumped(app, owner, { orderId: orderBId, pumped: true }));
    must(
      'pump on site',
      await schedulePumpJob(
        app,
        owner,
        {
          date: today,
          pumpId: pumpIds[0]!,
          operatorId: operator.id,
          orderId: orderBId,
          onSiteMin: 420,
          siteLabel: 'Chantier Démo Chefchaouen',
          plannedM3: 11,
        },
        cipher,
      ),
    );
    const manager = created.get('centrale-chefchaouen')!.session;
    must(
      'arrival counted',
      await confirmArrivalAtPlant(app, manager, {
        purchaseId: purchase.id,
        note: 'camion démo',
        lines: [
          {
            lineId: await purchaseLineOf(app, owner, purchase.id),
            arrivedMilli: 12_000,
            rejectedMilli: 1_000,
            available: true,
          },
        ],
      }),
    );
    const sent = must(
      'material transfer',
      await sendTransfer(app, owner, {
        kind: 'material',
        fromPlant: tet.id,
        toPlant: chf.id,
        componentId: comp('Ciment').id,
        qty: 5_000_000,
        date: today,
      }),
    );
    must('transfer picked up', await pickUpTransfer(app, owner, sent.id));
    must(
      'fuel transfer',
      await sendTransfer(app, owner, {
        kind: 'fuel',
        fromPlant: tet.id,
        toPlant: chf.id,
        qty: 500,
        date: today,
      }),
    );

    // 8b. R11-08: the finance module's database switch is turned on for the training instance (it defaults to off). This is provisioning by
    //     the seed, like the step-up flag of its other doors, not a runtime path: the application still asks every finance request for the
    //     user's REAL authenticator (a password-only training sign-in is refused by finance), which a training account may enrol on its own.
    await executeFinance(
      app,
      { user: { ...owner, twoFactorEnabled: true } as never, twoFactorAt: realClock.now() },
      { action: 'configure', enabled: true, leasingTreatment: 'expense' },
    );

    // 8c. T5: the working day of the training instance (rotations for the three drivers, orders to dispatch and to cancel, quotes,
    //     a delivery to receive, a low-stock alert), dated from today. `rearm:training` does the same on any later morning.
    lock.assertHeld('the training day');
    await armTrainingDay(env, today, { requireMarker: false });

    // 9. Credentials first, marker last (R11-04, R11-02). The file is staged privately and exclusively; if it cannot be written the seed
    //    stops here, with no marker, saying so. Only then is it put in place, and only then is the database marked: the marker means
    //    "completed seed, credentials in the hands of the operator". If the marker cannot be written the file is taken away again.
    let staged: StagedCredentials;
    try {
      lock.assertHeld('the staging of the credentials file');
      staged = stageCredentialsFile(
        opts.credentialsFile,
        renderCredentialsFile(env.APP_BASE_URL, issued, realClock.now()),
        lock.attempt,
      );
    } catch (error) {
      if (error instanceof SeedLockError) throw error; // a displaced attempt: its own message says so
      throw new SeedError(
        `training seed NOT completed: the credentials file could not be written (${error instanceof Error ? error.message : String(error)}). ` +
          'The accounts exist but nobody knows their passwords and the database is not marked: remove the training volume and start again.',
      );
    }
    // R19-12: placing the file, writing the marker and the conditional cleanup are ONE lifecycle (publishCredentials): each publication is one commit step,
    // and a failed attempt removes only the file it placed itself (found by identity, under the commit mutex), never a successor's.
    await publishCredentials(lock, staged, () =>
      migrator.query('insert into public.training_marker default values'),
    );
    return { applied: true, accounts: issued.length, credentialsFile: opts.credentialsFile };
  } finally {
    lock?.release();
    await Promise.all([app.end(), authPool.end(), system.end(), seed.end(), migrator.end()]);
  }
}

// Small reads and one insert the services do not offer under the same shape: all through the application's own login and an actor.
const unitOf = async (
  app: pg.Pool,
  actor: SessionUser,
  componentId: string,
  label: string,
): Promise<string> =>
  (
    await inRequest(app, actor, (tx) =>
      tx.query<{ id: string }>('select id from purchase_unit where component_id = $1 and label = $2', [
        componentId,
        label,
      ]),
    )
  ).rows[0]!.id;

const purchaseLineOf = async (app: pg.Pool, actor: SessionUser, purchaseId: string): Promise<string> =>
  (
    await inRequest(app, actor, (tx) =>
      tx.query<{ line_id: string }>('select line_id from purchase_line_ops where purchase_id = $1 limit 1', [
        purchaseId,
      ]),
    )
  ).rows[0]!.line_id;

const listDrivers = async (app: pg.Pool, actor: SessionUser) =>
  (
    await inRequest(app, actor, (tx) =>
      tx.query<{ id: string; code: string; name: string; kind: 'driver' | 'pump_operator' }>(
        `select id, code, name, kind from driver where status = 'active' and user_id is null order by code`,
      ),
    )
  ).rows;

async function addPumpOperator(app: pg.Pool, actor: SessionUser, name: string) {
  return (
    await inRequest(app, actor, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('driver:code', 0))`);
      const next = await tx.query<{ n: number }>(
        `select coalesce(max(substr(code, 4)::int), 0) + 1 as n from driver`,
      );
      const code = `CH-${String(next.rows[0]?.n ?? 1).padStart(2, '0')}`;
      return tx.query<{ id: string; code: string }>(
        `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'pump_operator') returning id, code`,
        [code, name, actor.id],
      );
    })
  ).rows[0]!;
}

/** R12-02: no default. The output path is explicit, and `validateCredentialsPath` refuses a checkout or a build context. */
function requireOutputPath(): string {
  const file = process.env.TRAINING_ACCOUNTS_FILE;
  if (!file)
    throw new Error(
      'TRAINING_ACCOUNTS_FILE is required: the path of the credentials file, in a private folder outside the checkout (the training stack sets /app/out/training-accounts.local.txt).',
    );
  return file;
}

if (import.meta.main) {
  const { handleHelp } = await import('./cli-help');
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
  const { loadMaintenanceEnv, loadSeedUrl } = await import('../src/lib/env.ts');
  const { businessDateOf, realClock } = await import('../src/modules/clock/index.ts');
  const env = { ...loadMaintenanceEnv(process.env), DATABASE_URL_SEED: loadSeedUrl(process.env) };
  try {
    const result = await seedTraining({
      env,
      today: businessDateOf(realClock.now()),
      credentialsFile: requireOutputPath(),
    });
    console.log(
      result.applied
        ? `Training data seeded: ${result.accounts} accounts, credentials written once to ${result.credentialsFile} (not shown here).`
        : 'This database is already seeded for training (nothing changed). Use `reset:training` to start again.',
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
