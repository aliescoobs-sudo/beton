import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

// Random reference text that can never look like money to the specs' "no amount on this page" pattern
// (/MAD|DH|\d\s?\d{3},\d{2}/): no D, H, M or A, so neither "DH" nor "MAD" can appear by chance. C0: a suffix such as
// "ALDHN9RS1" once made payment-allocation.spec.ts fail in a full run although the page showed no amount.
export function moneySafeSuffix(length = 6): string {
  const alphabet = 'BCEFGJKLNPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
/** A second server on the same database with the assistant flag OFF: the entry is absent and the endpoints answer 404 (AC-ASSIST-01). */
export const E2E_OFF_PORT = 3101;
export const E2E_OFF_URL = `http://localhost:${E2E_OFF_PORT}`;
export const E2E_PASSWORD = 'correct-horse-battery-staple';
export const E2E_USERS = {
  fr: { email: 'e2e-fr@belgobeton.test', name: 'Utilisateur E2E' },
  ar: { email: 'e2e-ar@belgobeton.test', name: 'مستخدم تجريبي' },
} as const;
export const E2E_OWNER = { email: 'e2e-owner@belgobeton.test', name: 'Propriétaire E2E' } as const;
export const E2E_PLANT = { email: 'e2e-plant@belgobeton.test', name: 'Centrale E2E' } as const;
/** master-data specs: a partner per locale (edit) and an office user (read-only), each enrolled once by its spec. */
export const E2E_MD = {
  partnerFr: { email: 'e2e-md-partner-fr@belgobeton.test', name: 'Associé MD' },
  partnerAr: { email: 'e2e-md-partner-ar@belgobeton.test', name: 'شريك البيانات' },
  office: { email: 'e2e-md-office@belgobeton.test', name: 'Bureau MD' },
  // master-client spec (one enrolment each, like the zone spec's users)
  clientPartnerFr: { email: 'e2e-cl-partner-fr@belgobeton.test', name: 'Associé Clients' },
  clientPartnerAr: { email: 'e2e-cl-partner-ar@belgobeton.test', name: 'شريك الزبائن' },
  clientOffice: { email: 'e2e-cl-office@belgobeton.test', name: 'Bureau Clients' },
  supplierOffice: { email: 'e2e-su-office@belgobeton.test', name: 'Bureau Fournisseurs' },
  supplierPartner: { email: 'e2e-su-partner@belgobeton.test', name: 'Associé Fournisseurs' },
  componentPartnerFr: { email: 'e2e-co-partner-fr@belgobeton.test', name: 'Associé Composants' },
  componentPartnerAr: { email: 'e2e-co-partner-ar@belgobeton.test', name: 'شريك المكوّنات' },
  componentPlant: { email: 'e2e-co-plant@belgobeton.test', name: 'Centrale Composants' },
  typePartnerFr: { email: 'e2e-ty-partner-fr@belgobeton.test', name: 'Associé Types' },
  typePartnerAr: { email: 'e2e-ty-partner-ar@belgobeton.test', name: 'شريك الأنواع' },
  typePlant: { email: 'e2e-ty-plant@belgobeton.test', name: 'Centrale Types' },
  recettePartnerFr: { email: 'e2e-re-partner-fr@belgobeton.test', name: 'Associé Recettes' },
  recettePartnerAr: { email: 'e2e-re-partner-ar@belgobeton.test', name: 'شريك الوصفات' },
  recettePlant: { email: 'e2e-re-plant@belgobeton.test', name: 'Centrale Recettes' },
  orderOffice: { email: 'e2e-or-office@belgobeton.test', name: 'Bureau Commandes' },
  orderOfficeAr: { email: 'e2e-or-office-ar@belgobeton.test', name: 'مكتب الطلبيات' },
  orderPartner: { email: 'e2e-or-partner@belgobeton.test', name: 'Associé Commandes' },
  orderPlant: { email: 'e2e-or-plant@belgobeton.test', name: 'Centrale Commandes' },
  priceSupport: { email: 'e2e-pp-support@belgobeton.test', name: 'Support Prix' },
  sellSupport: { email: 'e2e-sp-support@belgobeton.test', name: 'Support Ventes' },
  ovSupport: { email: 'e2e-ov-support@belgobeton.test', name: 'Support Remises' },
  pricePartnerFr: { email: 'e2e-pp-partner-fr@belgobeton.test', name: 'Associé Prix' },
  pricePartnerAr: { email: 'e2e-pp-partner-ar@belgobeton.test', name: 'شريك الأسعار' },
  priceOffice: { email: 'e2e-pp-office@belgobeton.test', name: 'Bureau Prix' },
  pricePlant: { email: 'e2e-pp-plant@belgobeton.test', name: 'Centrale Prix' },
  sellPartnerFr: { email: 'e2e-sp-partner-fr@belgobeton.test', name: 'Associé Ventes' },
  sellPartnerAr: { email: 'e2e-sp-partner-ar@belgobeton.test', name: 'شريك المبيعات' },
  sellOffice: { email: 'e2e-sp-office@belgobeton.test', name: 'Bureau Ventes' },
  sellPlant: { email: 'e2e-sp-plant@belgobeton.test', name: 'Centrale Ventes' },
  ovPartnerFr: { email: 'e2e-ov-partner-fr@belgobeton.test', name: 'Associé Remises' },
  ovPartnerAr: { email: 'e2e-ov-partner-ar@belgobeton.test', name: 'شريك الخصومات' },
  ovOffice: { email: 'e2e-ov-office@belgobeton.test', name: 'Bureau Remises' },
  truckPartnerFr: { email: 'e2e-tr-partner-fr@belgobeton.test', name: 'Associé Camions' },
  truckPartnerAr: { email: 'e2e-tr-partner-ar@belgobeton.test', name: 'شريك الشاحنات' },
  truckPlant: { email: 'e2e-tr-plant@belgobeton.test', name: 'Centrale Camions' },
  truckOffice: { email: 'e2e-tr-office@belgobeton.test', name: 'Bureau Camions' },
  plantsPartnerFr: { email: 'e2e-pl-partner-fr@belgobeton.test', name: 'Associé Centrales' },
  plantsPartnerAr: { email: 'e2e-pl-partner-ar@belgobeton.test', name: 'شريك المحطات' },
  plantsOffice: { email: 'e2e-pl-office@belgobeton.test', name: 'Bureau Centrales' },
  screensPartnerFr: { email: 'e2e-sc-partner-fr@belgobeton.test', name: 'Associé Écrans' },
  screensPartnerAr: { email: 'e2e-sc-partner-ar@belgobeton.test', name: 'شريك الشاشات' },
  clientPlant: { email: 'e2e-cl-plant@belgobeton.test', name: 'Centrale Clients' },
  acctSupport: { email: 'e2e-ac-support@belgobeton.test', name: 'Support Comptes' },
  acctOffice: { email: 'e2e-ac-office@belgobeton.test', name: 'Bureau Comptes' },
  cashSupport: { email: 'e2e-ca-support@belgobeton.test', name: 'Support Trésorerie' },
  cashOffice: { email: 'e2e-ca-office@belgobeton.test', name: 'Bureau Trésorerie' },
  payOffice: { email: 'e2e-py-office@belgobeton.test', name: 'Bureau Paiements' },
  payOfficeAr: { email: 'e2e-py-office-ar@belgobeton.test', name: 'مكتب الدفعات' },
  paySupport: { email: 'e2e-py-support@belgobeton.test', name: 'Support Paiements' },
  payPlant: { email: 'e2e-py-plant@belgobeton.test', name: 'Centrale Paiements' },
  openSupport: { email: 'e2e-op-support@belgobeton.test', name: 'Support Ouverture' },
  openOffice: { email: 'e2e-op-office@belgobeton.test', name: 'Bureau Ouverture' },
  stmSupport: { email: 'e2e-st-support@belgobeton.test', name: 'Support Comptes Tiers' },
  stmOffice: { email: 'e2e-st-office@belgobeton.test', name: 'Bureau Comptes Tiers' },
  acctPartner: { email: 'e2e-ac-partner@belgobeton.test', name: 'Associé Comptes' },
  loadPlant: { email: 'e2e-ld-plant@belgobeton.test', name: 'Centrale Chargements' },
  loadPlantAr: { email: 'e2e-ld-plant-ar@belgobeton.test', name: 'مركز التحميل' },
  quoteOffice: { email: 'e2e-qu-office@belgobeton.test', name: 'Bureau Devis' },
  purOffice: { email: 'e2e-pu-office@belgobeton.test', name: 'Bureau Achats' },
  purPlant: { email: 'e2e-pu-plant@belgobeton.test', name: 'Centrale Achats' },
  viewOffice: { email: 'e2e-vw-office@belgobeton.test', name: 'Bureau Vues' },
  flowOffice: { email: 'e2e-fl-office@belgobeton.test', name: 'Bureau Flux' },
  loadOffice: { email: 'e2e-ld-office@belgobeton.test', name: 'Bureau Chargements' },
  dashSupport: { email: 'e2e-da-support@belgobeton.test', name: 'Support Tableau' },
  dashOffice: { email: 'e2e-da-office@belgobeton.test', name: 'Bureau Tableau' },
  dashPlant: { email: 'e2e-da-plant@belgobeton.test', name: 'Centrale Tableau' },
  dashPartner: { email: 'e2e-da-partner@belgobeton.test', name: 'Associé Tableau' },
  dispPlant: { email: 'e2e-dp-plant@belgobeton.test', name: 'Centrale Planning' },
  dispPartner: { email: 'e2e-dp-partner@belgobeton.test', name: 'Associé Planning' },
  dispOffice: { email: 'e2e-dp-office@belgobeton.test', name: 'Bureau Planning' },
  tripPlant: { email: 'e2e-tp-plant@belgobeton.test', name: 'Centrale Rotations' },
  tripPlantAr: { email: 'e2e-tp-plant-ar@belgobeton.test', name: 'مركز الرحلات' },
  queueOffice: { email: 'e2e-iq-office@belgobeton.test', name: 'Bureau À facturer' },
  queueOfficeAr: { email: 'e2e-iq-office-ar@belgobeton.test', name: 'مكتب الفوترة' },
  chainOffice: { email: 'e2e-ch-office@belgobeton.test', name: 'Bureau Chaîne' },
  chainPlant: { email: 'e2e-ch-plant@belgobeton.test', name: 'Centrale Chaîne' },
  chainPlantAr: { email: 'e2e-ch-plant-ar@belgobeton.test', name: 'مركز السلسلة' },
  siOffice: { email: 'e2e-si-office@belgobeton.test', name: 'Bureau Factures Fournisseurs' },
  siSupport: { email: 'e2e-si-support@belgobeton.test', name: 'Support Factures Fournisseurs' },
  siPlant: { email: 'e2e-si-plant@belgobeton.test', name: 'Centrale Factures Fournisseurs' },
  avoirSupport: { email: 'e2e-av-support@belgobeton.test', name: 'Support Avoirs' },
  avoirOffice: { email: 'e2e-av-office@belgobeton.test', name: 'Bureau Avoirs' },
  allocOffice: { email: 'e2e-al-office@belgobeton.test', name: 'Bureau Imputations' },
  pumpOffice: { email: 'e2e-pm-office@belgobeton.test', name: 'Bureau Pompes' },
  driverPhotoPlant: { email: 'e2e-bp-plant@belgobeton.test', name: 'Centrale Photos BL' },
  queuePlant: { email: 'e2e-iq-plant@belgobeton.test', name: 'Centrale À facturer' },
  queueSupport: { email: 'e2e-iq-support@belgobeton.test', name: 'Support À facturer' },
  tripOffice: { email: 'e2e-tp-office@belgobeton.test', name: 'Bureau Rotations' },
  repPlant: { email: 'e2e-rp-plant@belgobeton.test', name: 'Centrale Rapports' },
  repPlantAr: { email: 'e2e-rp-plant-ar@belgobeton.test', name: 'مركز التقارير' },
  repPartner: { email: 'e2e-rp-partner@belgobeton.test', name: 'Associé Rapports' },
  repOffice: { email: 'e2e-rp-office@belgobeton.test', name: 'Bureau Rapports' },
  rdPlant: { email: 'e2e-rd-plant@belgobeton.test', name: 'Centrale Couverture' },
  fuelPlant: { email: 'e2e-fu-plant@belgobeton.test', name: 'Centrale Carburant' },
  fuelPartner: { email: 'e2e-fu-partner@belgobeton.test', name: 'Associé Carburant' },
  lossPlant: { email: 'e2e-lo-plant@belgobeton.test', name: 'Centrale Pertes' },
  lossOffice: { email: 'e2e-lo-office@belgobeton.test', name: 'Bureau Pertes' },
  anPartner: { email: 'e2e-an-partner@belgobeton.test', name: 'Associé Volumes' },
  anPlant: { email: 'e2e-an-plant@belgobeton.test', name: 'Centrale Volumes' },
  astOffice: { email: 'e2e-as-office@belgobeton.test', name: 'Bureau Assistant' },
  astOfficeAr: { email: 'e2e-as-office-ar@belgobeton.test', name: 'مكتب المساعد' },
  astPlant: { email: 'e2e-as-plant@belgobeton.test', name: 'Centrale Assistant' },
  astPlantAr: { email: 'e2e-as-plant-ar@belgobeton.test', name: 'مركز المساعد' },
  astSupport: { email: 'e2e-as-support@belgobeton.test', name: 'Support Assistant' },
  astOff: { email: 'e2e-as-off@belgobeton.test', name: 'Support Assistant coupé' },
  astPartner: { email: 'e2e-as-partner@belgobeton.test', name: 'Associé Assistant' },
} as const;
export const E2E_CSP = { email: 'e2e-csp@belgobeton.test', name: 'CSP E2E' } as const;

/** TOTP from the key shown on the enrolment page, as an authenticator app would compute it. */
export async function totpFromDisplayedKey(displayed: string): Promise<string> {
  const raw = new TextDecoder().decode(base32.decode(displayed.replace(/\s+/g, '')));
  return createOTP(raw).totp();
}

/** Milliseconds until the next 30-second TOTP step (a code is accepted only once). */
export function msUntilNextStep(): number {
  return 30_000 - (Date.now() % 30_000) + 500;
}

export async function passwordStep(page: Page, locale: string, email: string) {
  await page.goto(`/${locale}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
}

const NAV_GROUP: Record<string, string> = {
  'clients-link': 'sales',
  'selling-prices-link': 'sales',
  'orders-new-link': 'sales',
  'orders-link': 'sales',
  'order-chain-link': 'sales',
  'quotes-link': 'sales',
  'quotes-new-link': 'sales',
  'suppliers-link': 'purchases',
  'purchases-link': 'purchases',
  'supplier-invoices-link': 'purchases',
  'supplier-invoices-new-link': 'purchases',
  'purchases-new-link': 'purchases',
  'purchase-prices-link': 'purchases',
  'recettes-link': 'production',
  'trucks-link': 'production',
  'loads-link': 'production',
  'dispatch-link': 'production',
  'dispatch-office-link': 'production',
  'trips-link': 'production',
  'consumption-report-link': 'production',
  'fuel-link': 'production',
  'analytics-link': 'sales',
  'stock-link': 'production',
  'receipts-link': 'production',
  'accounts-link': 'finance',
  'cash-link': 'finance',
  'statements-link': 'finance',
  'opening-link': 'finance',
  'instruments-link': 'finance',
  'payments-new-link': 'sales',
  'invoices-new-link': 'sales',
  'invoice-queue-link': 'sales',
  'invoices-link': 'finance',
  'avoirs-link': 'finance',
  'deadlines-link': 'finance',
  'accounting-link': 'finance',
  'zones-link': 'masterData',
  'plants-link': 'masterData',
  'concrete-types-link': 'masterData',
  'components-link': 'masterData',
  'admin-link': 'administration',
  'parameters-link': 'administration',
  'checklist-link': 'administration',
  'company-link': 'administration',
  'history-link': 'administration',
  'security-link': 'administration',
};

/** Opens a page through the navigation: the group tab first when the page's link is not in the current band. */
export async function goNav(page: Page, linkTestId: string) {
  const link = page.getByTestId(linkTestId);
  if (!(await link.isVisible())) {
    await page.getByTestId(`tab-${NAV_GROUP[linkTestId]}`).click();
    // A group with a single page has no sub-page band: its tab already opened that page.
    const shown = await link.waitFor({ state: 'visible', timeout: 3000 }).then(
      () => true,
      () => false,
    );
    if (!shown) return;
  }
  await link.click();
}

/** Opens the user menu in the top bar and signs out. */
export async function logout(page: Page) {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('logout').click();
}

/** Password login of a not-yet-enrolled user, then enrolment in the browser. Returns the displayed key. */
export async function loginAndEnrol(page: Page, locale: string, email: string): Promise<string> {
  await passwordStep(page, locale, email);
  await expect(page).toHaveURL(`/${locale}/enrol`);
  await page.fill('input[name=password]', E2E_PASSWORD);
  await page.click('button[type=submit]');
  const key = (await page.getByTestId('totp-secret').textContent()) ?? '';
  await page.check('input[type=checkbox]');
  await page.fill('input[name=code]', await totpFromDisplayedKey(key));
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`/${locale}`);
  return key;
}

// There is a single owner account, enrolled once per e2e run: its authenticator key is kept here so that every spec
// that needs the owner (only the owner writes prices, DECISIONS 81) can sign in again.
const OWNER_STATE = 'test-results/e2e-owner-totp.json';

export function resetOwnerState() {
  rmSync(OWNER_STATE, { force: true });
}

/** Signs the e2e owner in: enrols on the first call, then password + TOTP (a code is accepted once per 30 s step). */
export async function loginOwner(page: Page, locale: string): Promise<void> {
  const step = () => Math.floor(Date.now() / 30_000);
  const save = (key: string) => {
    mkdirSync('test-results', { recursive: true });
    writeFileSync(OWNER_STATE, JSON.stringify({ key, step: step() }));
  };
  if (!existsSync(OWNER_STATE)) {
    save(await loginAndEnrol(page, locale, E2E_OWNER.email));
    return;
  }
  const state = JSON.parse(readFileSync(OWNER_STATE, 'utf8')) as { key: string; step: number };
  await passwordStep(page, locale, E2E_OWNER.email);
  await expect(page.locator('input[name=code]')).toBeVisible();
  if (step() <= state.step) await page.waitForTimeout(msUntilNextStep());
  await page.fill('input[name=code]', await totpFromDisplayedKey(state.key));
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(`/${locale}`);
  save(state.key);
}
