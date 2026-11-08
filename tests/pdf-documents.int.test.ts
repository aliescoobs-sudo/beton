import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { formatCentimes } from '../src/lib/money';
import { readPdf } from '../src/lib/pdf/read-text';
import {
  avoirPdf,
  type CompanyProfile,
  getClientStatement,
  getInvoiceDocument,
  invoicePdf,
  listAvoirs,
  listInvoices,
  SPECIMEN,
  statementPdf,
} from '../src/modules/ledger';
import { deliveryNotePdf, getDeliveryNote } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  deliveryScene,
  type DeliveryScene,
  newAvoir,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// integration I3.4: the server-side PDFs read the stored figures, carry the legal mentions, show the pilot watermark, and the BL has no price. AC-INT-19.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'plant' | 'support', SessionUser>;
const marker = `pd${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-07-03';
let scene: DeliveryScene;
let master: OrderMaster;
let sold: Awaited<ReturnType<typeof newAvoir>>;

const company: CompanyProfile = {
  effectiveFrom: '2026-01-01',
  legalName: 'Béton Fictif SARL',
  legalForm: 'SARL',
  ice: '001234567000089',
  ifNumber: '12345678',
  rcNumber: '98765',
  patente: '55501234',
  address: '1 rue du Test, Casablanca',
  phone: null,
  email: null,
  rib: '181780000012345678901234',
};

beforeAll(async () => {
  for (const role of ['owner', 'plant', 'support'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
  sold = await withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
    newAvoir(tx, users.owner.id, master, scene, marker, { today: TODAY }),
  );
});

const all = (bytes: Uint8Array) => readPdf(bytes).pages.join('\n');
// the PDF has no narrow no-break space: the fonts show it as a plain space
const amount = (centimes: number) => formatCentimes(centimes).replace(/\u202f/g, ' ');

describe('the invoice PDF (AC-INT-19)', () => {
  it('prints the stored figures, the legal mentions, the BL numbers, the advance and the net to pay', async () => {
    const invoice = (await listInvoices(app, users.owner)).find((i) => i.number === sold.number);
    const doc = await getInvoiceDocument(app, users.owner, invoice?.id as string);
    if (!doc) throw new Error('no document');
    const text = all(invoicePdf(doc, { company, specimen: false }));
    expect(text).toContain(`Facture ${doc.invoice.number}`);
    expect(text).toContain('ICE 001234567000089');
    expect(text).toContain('RIB 181 780');
    expect(text).toContain(`adv${marker}`);
    for (const g of doc.groups) for (const bl of g.blNos) expect(text).toContain(bl);
    expect(text).toContain(amount(doc.invoice.totalTtcCentimes));
    expect(text).toContain('Acompte reçu');
    expect(text).toContain(amount(doc.advanceCentimes));
    expect(text).toContain('Net à payer');
    expect(text).toContain(amount(doc.netToPayCentimes));
    expect(text).toContain('loi 69-21');
    expect(text).not.toContain('SPÉCIMEN');
  });

  it('carries the specimen watermark on every page of a pilot document', async () => {
    const invoice = (await listInvoices(app, users.owner)).find((i) => i.number === sold.number);
    const doc = await getInvoiceDocument(app, users.owner, invoice?.id as string);
    if (!doc) throw new Error('no document');
    const pages = readPdf(invoicePdf(doc, { company, specimen: true })).pages;
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p).toContain(SPECIMEN.replace('—', '\u0097').replace('É', 'É'));
  });

  it('says so when the company profile is missing, and never throws', async () => {
    const invoice = (await listInvoices(app, users.owner)).find((i) => i.number === sold.number);
    const doc = await getInvoiceDocument(app, users.owner, invoice?.id as string);
    expect(all(invoicePdf(doc as NonNullable<typeof doc>, { company: null, specimen: false }))).toContain(
      'à renseigner',
    );
  });
});

describe('the avoir and the statement PDFs (AC-INT-19)', () => {
  it('the avoir references the invoice, the BL and the reason', async () => {
    const avoir = (await listAvoirs(app, users.owner)).find((a) => a.number === sold.avoirNumber);
    if (!avoir) throw new Error('no avoir');
    const text = all(avoirPdf(avoir, { company, specimen: false }));
    expect(text).toContain(avoir.number);
    expect(text).toContain(avoir.invoiceNumber);
    expect(text).toContain(avoir.blNo);
    expect(text).toContain('refusé par le client');
    expect(text).toContain(amount(avoir.totalTtcCentimes));
  });

  it('the client statement lists the lines and the closing balance', async () => {
    const r = await getClientStatement(app, users.owner, sold.clientId, {}, { today: TODAY });
    if (!r) throw new Error('no statement');
    const text = all(statementPdf('client', r, r.statement, TODAY, { company, specimen: false }));
    expect(text).toContain(`Relevé client ${r.code}`);
    expect(text).toContain(sold.number as string);
    expect(text).toContain(amount(Number(r.statement.closing)));
  });
});

describe('the BL PDF (AC-INT-19)', () => {
  it('has names, places and quantities, and no price, total or payment, for the plant as for the owner', async () => {
    for (const role of ['plant', 'owner'] as const) {
      const note = await getDeliveryNote(app, users[role], sold.deliveryId);
      if (!note) throw new Error('no note');
      const text = all(deliveryNotePdf(note, { specimen: true, company: ['Béton Fictif SARL (SARL)'] }));
      expect(text).toContain(`Bon de livraison ${note.blNo}`);
      expect(text).toContain(note.truckPlate);
      expect(text).not.toMatch(/MAD|TVA|HT\b|TTC|Total|Prix|Acompte/);
    }
  });
});
