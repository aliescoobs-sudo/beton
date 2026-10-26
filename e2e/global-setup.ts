import pg from 'pg';
import { E2E_DATABASE, ensureRoles, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedPilotMasterData } from '../src/modules/master-data';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { testEnv } from '../tests/db-env';
import {
  E2E_BASE_URL,
  E2E_CSP,
  E2E_MD,
  E2E_OWNER,
  E2E_PASSWORD,
  E2E_PLANT,
  E2E_USERS,
  resetOwnerState,
} from './fixtures';

/** Fresh e2e database: an owner, a plant user and one partner per locale, none enrolled yet. */
export default async function globalSetup() {
  resetOwnerState();
  const env = { ...testEnv(E2E_DATABASE), APP_BASE_URL: E2E_BASE_URL };
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
      ...E2E_CSP,
      password: E2E_PASSWORD,
      role: 'office',
      locale: 'fr',
    });
    for (const [user, role, locale] of [
      [E2E_MD.partnerFr, 'partner', 'fr'],
      [E2E_MD.partnerAr, 'partner', 'ar'],
      [E2E_MD.office, 'office', 'fr'],
      [E2E_MD.clientPartnerFr, 'partner', 'fr'],
      [E2E_MD.clientPartnerAr, 'partner', 'ar'],
      [E2E_MD.clientOffice, 'office', 'fr'],
      [E2E_MD.clientPlant, 'plant', 'fr'],
      [E2E_MD.recettePartnerFr, 'partner', 'fr'],
      [E2E_MD.recettePartnerAr, 'partner', 'ar'],
      [E2E_MD.recettePlant, 'plant', 'fr'],
      [E2E_MD.orderOffice, 'office', 'fr'],
      [E2E_MD.acctSupport, 'support', 'fr'],
      [E2E_MD.stmSupport, 'support', 'fr'],
      [E2E_MD.stmOffice, 'office', 'fr'],
      [E2E_MD.openSupport, 'support', 'fr'],
      [E2E_MD.openOffice, 'office', 'fr'],
      [E2E_MD.payOffice, 'office', 'fr'],
      [E2E_MD.payOfficeAr, 'office', 'ar'],
      [E2E_MD.paySupport, 'support', 'fr'],
      [E2E_MD.payPlant, 'plant', 'fr'],
      [E2E_MD.loadPlant, 'plant', 'fr'],
      [E2E_MD.loadPlantAr, 'plant', 'ar'],
      [E2E_MD.loadOffice, 'office', 'fr'],
      [E2E_MD.dashSupport, 'support', 'fr'],
      [E2E_MD.dashOffice, 'office', 'fr'],
      [E2E_MD.dashPlant, 'plant', 'fr'],
      [E2E_MD.dispPlant, 'plant', 'fr'],
      [E2E_MD.dispPartner, 'partner', 'fr'],
      [E2E_MD.dispOffice, 'office', 'fr'],
      [E2E_MD.tripPlant, 'plant', 'fr'],
      [E2E_MD.tripPlantAr, 'plant', 'ar'],
      [E2E_MD.tripOffice, 'office', 'fr'],
      [E2E_MD.queueOffice, 'office', 'fr'],
      [E2E_MD.queueOfficeAr, 'office', 'ar'],
      [E2E_MD.queueSupport, 'support', 'fr'],
      [E2E_MD.queuePlant, 'plant', 'fr'],
      [E2E_MD.allocOffice, 'office', 'fr'],
      [E2E_MD.avoirSupport, 'support', 'fr'],
      [E2E_MD.avoirOffice, 'office', 'fr'],
      [E2E_MD.repPlant, 'plant', 'fr'],
      [E2E_MD.repPlantAr, 'plant', 'ar'],
      [E2E_MD.repPartner, 'partner', 'fr'],
      [E2E_MD.repOffice, 'office', 'fr'],
      [E2E_MD.rdPlant, 'plant', 'fr'],
      [E2E_MD.fuelPlant, 'plant', 'fr'],
      [E2E_MD.fuelPartner, 'partner', 'fr'],
      [E2E_MD.lossPlant, 'plant', 'fr'],
      [E2E_MD.lossOffice, 'office', 'fr'],
      [E2E_MD.anPartner, 'partner', 'fr'],
      [E2E_MD.anPlant, 'plant', 'fr'],
      [E2E_MD.dashPartner, 'partner', 'fr'],
      [E2E_MD.flowOffice, 'office', 'fr'],
      [E2E_MD.viewOffice, 'office', 'fr'],
      [E2E_MD.purOffice, 'office', 'fr'],
      [E2E_MD.quoteOffice, 'office', 'fr'],
      [E2E_MD.purPlant, 'plant', 'fr'],
      [E2E_MD.cashSupport, 'support', 'fr'],
      [E2E_MD.cashOffice, 'office', 'fr'],
      [E2E_MD.acctOffice, 'office', 'fr'],
      [E2E_MD.acctPartner, 'partner', 'fr'],
      [E2E_MD.orderOfficeAr, 'office', 'ar'],
      [E2E_MD.orderPartner, 'partner', 'fr'],
      [E2E_MD.orderPlant, 'plant', 'fr'],
      [E2E_MD.priceSupport, 'support', 'fr'],
      [E2E_MD.sellSupport, 'support', 'fr'],
      [E2E_MD.ovSupport, 'support', 'fr'],
      [E2E_MD.pricePartnerFr, 'partner', 'fr'],
      [E2E_MD.pricePartnerAr, 'partner', 'ar'],
      [E2E_MD.priceOffice, 'office', 'fr'],
      [E2E_MD.pricePlant, 'plant', 'fr'],
      [E2E_MD.sellPartnerFr, 'partner', 'fr'],
      [E2E_MD.sellPartnerAr, 'partner', 'ar'],
      [E2E_MD.sellOffice, 'office', 'fr'],
      [E2E_MD.sellPlant, 'plant', 'fr'],
      [E2E_MD.ovPartnerFr, 'partner', 'fr'],
      [E2E_MD.ovPartnerAr, 'partner', 'ar'],
      [E2E_MD.ovOffice, 'office', 'fr'],
      [E2E_MD.typePartnerFr, 'partner', 'fr'],
      [E2E_MD.typePartnerAr, 'partner', 'ar'],
      [E2E_MD.typePlant, 'plant', 'fr'],
      [E2E_MD.componentPartnerFr, 'partner', 'fr'],
      [E2E_MD.componentPartnerAr, 'partner', 'ar'],
      [E2E_MD.componentPlant, 'plant', 'fr'],
      [E2E_MD.screensPartnerFr, 'partner', 'fr'],
      [E2E_MD.screensPartnerAr, 'partner', 'ar'],
      [E2E_MD.truckPartnerFr, 'partner', 'fr'],
      [E2E_MD.truckPartnerAr, 'partner', 'ar'],
      [E2E_MD.truckPlant, 'plant', 'fr'],
      [E2E_MD.truckOffice, 'office', 'fr'],
      [E2E_MD.supplierOffice, 'office', 'fr'],
      [E2E_MD.supplierPartner, 'partner', 'fr'],
    ] as const) {
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
        role: 'partner',
        locale: locale as 'fr' | 'ar',
      });
    }
  } finally {
    await authPool.end();
  }
}
