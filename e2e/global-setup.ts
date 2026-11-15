import pg from 'pg';
import { E2E_DATABASE, ensureRoles, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedPilotMasterData } from '../src/modules/master-data';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { testEnv } from '../tests/db-env';
import { assertE2eTarget } from './admission';
import {
  E2E_BASE_URL,
  E2E_CSP,
  E2E_TRAINING_ACCOUNTANT,
  E2E_TRAINING_USER,
  E2E_MD,
  E2E_OWNER,
  E2E_PASSWORD,
  E2E_PLANT,
  E2E_USERS,
  resetOwnerState,
} from './fixtures';

/** Fresh e2e database: an owner, a plant user and one app_admin per locale, none enrolled yet. */
export default async function globalSetup() {
  resetOwnerState();
  const env = { ...testEnv(E2E_DATABASE), APP_BASE_URL: E2E_BASE_URL };
  assertE2eTarget(process.env, [
    env.DATABASE_URL_APP,
    env.DATABASE_URL_MIGRATOR,
    env.DATABASE_URL_AUTH,
    env.DATABASE_URL_SYSTEM,
    env.DATABASE_URL_SEED,
  ]);
  await ensureRoles(env, env.DATABASE_URL_SEED);
  await recreateDatabase(env, E2E_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  const seed = new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 1 });
  try {
    await seedPilotMasterData(seed, { SIMULATION_ENABLED: true, REAL_DATA: false, NODE_ENV: 'test' });
  } finally {
    await seed.end();
  }

  const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
  const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
  try {
    const auth = createAuth({ authPool, env, log: () => undefined });
    const bootstrap = { userId: BOOTSTRAP_ACTOR_ID, role: 'system' as const };
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_OWNER,
      password: E2E_PASSWORD,
      role: 'owner',
      locale: 'fr',
    });
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_PLANT,
      password: E2E_PASSWORD,
      role: 'plant',
      locale: 'fr',
    });
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_TRAINING_USER,
      password: E2E_PASSWORD,
      role: 'office_sales',
      locale: 'fr',
    });
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_TRAINING_ACCOUNTANT,
      password: E2E_PASSWORD,
      role: 'accountant',
      locale: 'fr',
    });
    await createUser(auth, authPool, {
      actor: bootstrap,
      ...E2E_CSP,
      password: E2E_PASSWORD,
      role: 'office',
      locale: 'fr',
    });
    for (const [user, role, locale] of [
      [E2E_MD.adminFr, 'app_admin', 'fr'],
      [E2E_MD.adminAr, 'app_admin', 'ar'],
      [E2E_MD.office, 'office', 'fr'],
      [E2E_MD.clientAdminFr, 'app_admin', 'fr'],
      [E2E_MD.clientAdminAr, 'app_admin', 'ar'],
      [E2E_MD.clientOffice, 'office', 'fr'],
      [E2E_MD.clientPlant, 'plant', 'fr'],
      [E2E_MD.recetteAdminFr, 'app_admin', 'fr'],
      [E2E_MD.recetteAdminAr, 'app_admin', 'ar'],
      [E2E_MD.recettePlant, 'plant', 'fr'],
      [E2E_MD.orderOffice, 'office', 'fr'],
      [E2E_MD.t18OfficeFr, 'office', 'fr'],
      [E2E_MD.t18OfficeAr, 'office', 'ar'],
      [E2E_MD.t18PlantFr, 'plant', 'fr'],
      [E2E_MD.t18PlantAr, 'plant', 'ar'],
      [E2E_MD.t19SalesFr, 'office_sales', 'fr'],
      [E2E_MD.t19SalesAr, 'office_sales', 'ar'],
      [E2E_MD.t19PurchFr, 'office_purchases', 'fr'],
      [E2E_MD.t19PurchAr, 'office_purchases', 'ar'],
      [E2E_MD.acctAccountant, 'accountant', 'fr'],
      [E2E_MD.stmAccountant, 'accountant', 'fr'],
      [E2E_MD.stmOffice, 'office', 'fr'],
      [E2E_MD.openAccountant, 'accountant', 'fr'],
      [E2E_MD.openOffice, 'office', 'fr'],
      [E2E_MD.payOffice, 'office', 'fr'],
      [E2E_MD.payOfficeAr, 'office', 'ar'],
      [E2E_MD.payAccountant, 'accountant', 'fr'],
      [E2E_MD.payPlant, 'plant', 'fr'],
      [E2E_MD.loadPlant, 'plant', 'fr'],
      [E2E_MD.loadPlantAr, 'plant', 'ar'],
      [E2E_MD.loadOffice, 'office', 'fr'],
      [E2E_MD.dashAccountant, 'accountant', 'fr'],
      [E2E_MD.dashOffice, 'office', 'fr'],
      [E2E_MD.dashPlant, 'plant', 'fr'],
      [E2E_MD.dispPlant, 'plant', 'fr'],
      [E2E_MD.dispAdmin, 'app_admin', 'fr'],
      [E2E_MD.dispOffice, 'office', 'fr'],
      [E2E_MD.tripPlant, 'plant', 'fr'],
      [E2E_MD.tripPlantAr, 'plant', 'ar'],
      [E2E_MD.tripOffice, 'office', 'fr'],
      [E2E_MD.queueOffice, 'office', 'fr'],
      [E2E_MD.heldOffice, 'office', 'fr'],
      [E2E_MD.queueOfficeAr, 'office', 'ar'],
      [E2E_MD.queueAccountant, 'accountant', 'fr'],
      [E2E_MD.queuePlant, 'plant', 'fr'],
      [E2E_MD.allocOffice, 'office', 'fr'],
      [E2E_MD.driverPhotoPlant, 'plant', 'fr'],
      [E2E_MD.pumpOffice, 'office', 'fr'],
      [E2E_MD.avoirAccountant, 'accountant', 'fr'],
      [E2E_MD.siOffice, 'office', 'fr'],
      [E2E_MD.chainOffice, 'office', 'fr'],
      [E2E_MD.chainPlant, 'plant', 'fr'],
      [E2E_MD.chainPlantAr, 'plant', 'ar'],
      [E2E_MD.siAccountant, 'accountant', 'fr'],
      [E2E_MD.siPlant, 'plant', 'fr'],
      [E2E_MD.avoirOffice, 'office', 'fr'],
      [E2E_MD.repPlant, 'plant', 'fr'],
      [E2E_MD.repPlantAr, 'plant', 'ar'],
      [E2E_MD.repAdmin, 'app_admin', 'fr'],
      [E2E_MD.repOffice, 'office', 'fr'],
      [E2E_MD.rdPlant, 'plant', 'fr'],
      [E2E_MD.fuelPlant, 'plant', 'fr'],
      [E2E_MD.fuelAdmin, 'app_admin', 'fr'],
      [E2E_MD.lossPlant, 'plant', 'fr'],
      [E2E_MD.lossOffice, 'office', 'fr'],
      [E2E_MD.anAdmin, 'app_admin', 'fr'],
      [E2E_MD.anPlant, 'plant', 'fr'],
      [E2E_MD.dashAdmin, 'app_admin', 'fr'],
      [E2E_MD.flowOffice, 'office', 'fr'],
      [E2E_MD.viewOffice, 'office', 'fr'],
      [E2E_MD.purOffice, 'office', 'fr'],
      [E2E_MD.quoteOffice, 'office', 'fr'],
      [E2E_MD.purPlant, 'plant', 'fr'],
      [E2E_MD.cashAccountant, 'accountant', 'fr'],
      [E2E_MD.psOffice, 'office', 'fr'],
      [E2E_MD.psPlant, 'plant', 'fr'],
      [E2E_MD.finAccountant, 'accountant', 'fr'],
      [E2E_MD.cashOffice, 'office', 'fr'],
      [E2E_MD.acctOffice, 'office', 'fr'],
      [E2E_MD.acctAdmin, 'app_admin', 'fr'],
      [E2E_MD.orderOfficeAr, 'office', 'ar'],
      [E2E_MD.orderAdmin, 'app_admin', 'fr'],
      [E2E_MD.orderPlant, 'plant', 'fr'],
      [E2E_MD.priceAccountant, 'accountant', 'fr'],
      [E2E_MD.sellAccountant, 'accountant', 'fr'],
      [E2E_MD.ovAccountant, 'accountant', 'fr'],
      [E2E_MD.priceAdminFr, 'app_admin', 'fr'],
      [E2E_MD.priceAdminAr, 'app_admin', 'ar'],
      [E2E_MD.priceOffice, 'office', 'fr'],
      [E2E_MD.pricePlant, 'plant', 'fr'],
      [E2E_MD.sellAdminFr, 'app_admin', 'fr'],
      [E2E_MD.sellAdminAr, 'app_admin', 'ar'],
      [E2E_MD.sellOffice, 'office', 'fr'],
      [E2E_MD.sellPlant, 'plant', 'fr'],
      [E2E_MD.ovAdminFr, 'app_admin', 'fr'],
      [E2E_MD.ovAdminAr, 'app_admin', 'ar'],
      [E2E_MD.ovOffice, 'office', 'fr'],
      [E2E_MD.typeAdminFr, 'app_admin', 'fr'],
      [E2E_MD.typeAdminAr, 'app_admin', 'ar'],
      [E2E_MD.typePlant, 'plant', 'fr'],
      [E2E_MD.componentAdminFr, 'app_admin', 'fr'],
      [E2E_MD.componentAdminAr, 'app_admin', 'ar'],
      [E2E_MD.componentPlant, 'plant', 'fr'],
      [E2E_MD.screensAdminFr, 'app_admin', 'fr'],
      [E2E_MD.plantsAdminFr, 'app_admin', 'fr'],
      [E2E_MD.plantsAdminAr, 'app_admin', 'ar'],
      [E2E_MD.plantsOffice, 'office', 'fr'],
      [E2E_MD.screensAdminAr, 'app_admin', 'ar'],
      [E2E_MD.truckAdminFr, 'app_admin', 'fr'],
      [E2E_MD.truckAdminAr, 'app_admin', 'ar'],
      [E2E_MD.truckPlant, 'plant', 'fr'],
      [E2E_MD.truckOffice, 'office', 'fr'],
      [E2E_MD.supplierOffice, 'office', 'fr'],
      [E2E_MD.supplierAdmin, 'app_admin', 'fr'],
      [E2E_MD.astOffice, 'office', 'fr'],
      [E2E_MD.astOfficeAr, 'office', 'ar'],
      [E2E_MD.astPlant, 'plant', 'fr'],
      [E2E_MD.astPlantAr, 'plant', 'ar'],
      [E2E_MD.astAccountant, 'accountant', 'fr'],
      [E2E_MD.astAdmin, 'app_admin', 'fr'],
      [E2E_MD.astOff, 'accountant', 'fr'],
    ] as const) {
      // T10a (R17-03): the reserved roles have no usable accounts in V1. R18 4E: the fixtures are NAMED for what they are: app_admin (the
      // administrative editor of master data and the books) and accountant (read-only on the books).
      await createUser(auth, authPool, {
        actor: bootstrap,
        email: user.email,
        name: user.name,
        password: E2E_PASSWORD,
        role,
        locale,
      });
    }
    for (const [locale, user] of Object.entries(E2E_USERS)) {
      await createUser(auth, authPool, {
        actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
        email: user.email,
        name: user.name,
        password: E2E_PASSWORD,
        role: 'app_admin', // formerly a promoted `app_admin`: reserved roles cannot sign in any more (T10a)
        locale: locale as 'fr' | 'ar',
      });
    }
  } finally {
    await Promise.all([authPool.end(), migrator.end()]);
  }
}
