import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  decideDocumentRequest,
  getInvoiceTiming,
  listMyDocumentRequests,
  listPendingDocumentRequests,
  requestDocument,
  setInvoiceSequence,
  setInvoiceTiming,
  releaseDocumentRequest,
  consumeDocumentCopy,
  createQuote,
} from '../src/modules/ledger';
import { createConcreteType, createListPrice } from '../src/modules/master-data';
import { listMyNotifications } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

// R7 (CP-PROD-PLAN, REQUIREMENTS-V1 §9, §12): the gate for number-bearing documents, the invoice timing, the numbering.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await app.end();
});
const marker = `dv${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const u = {} as Record<string, SessionUser>;
let clientCode = '';
let supplierCode = '';
const refused = async (p: Promise<{ ok: boolean }>) => {
  try {
    return !(await p).ok;
  } catch {
    return true;
  }
};

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  u.owner = v.owner;
  for (const r of ['app_admin', 'office_sales', 'office_purchases', 'accountant', 'plant_manager'] as const)
    u[r] = v.session(r);
  await withRlsContext(app, { userId: v.owner.id, role: 'owner', requestId: marker }, async (tx) => {
    clientCode = (
      await tx.query<{ code: string }>(
        `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning code`,
        [`dv${marker}`],
      )
    ).rows[0]!.code;
    supplierCode = (
      await tx.query<{ code: string }>(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'other') returning code`,
        [`dvs${marker}`],
      )
    ).rows[0]!.code;
  });
});

const ask = (who: string, extra: Record<string, unknown> = {}) =>
  requestDocument(app, u[who]!, {
    kind: 'invoice_copy',
    partyKind: 'client',
    partyCode: clientCode,
    docRef: `FA-2026-${Math.floor(Math.random() * 90000) + 10000}`,
    ...extra,
  });

describe('the gate for documents a client asks for', () => {
  it('sales asks, nothing is released, the owner is told, and the request holds no amount', async () => {
    const r = await ask('office_sales');
    if (!r.ok) throw new Error(r.error);
    const mine = await listMyDocumentRequests(app, u.office_sales!);
    expect(mine.find((m) => m.id === r.value.id)?.status).toBe('pending');
    expect(await refused(releaseDocumentRequest(app, u.office_sales!, r.value.id))).toBe(true);
    expect((await listMyNotifications(app, u.owner!, 80)).some((n) => n.kind === 'document_request')).toBe(
      true,
    );
    const cols = await withRlsContext(app, { userId: u.owner!.id, role: 'owner', requestId: marker }, (tx) =>
      tx.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'document_request'`,
      ),
    );
    for (const c of cols.rows) expect(c.column_name).not.toMatch(/centime|price|amount|total|balance/);
  });
  it('the roles are respected: sales for clients, purchases for suppliers, nobody else', async () => {
    expect(await refused(ask('office_purchases'))).toBe(true);
    expect(await refused(ask('office_sales', { partyKind: 'supplier', partyCode: supplierCode }))).toBe(true);
    const ok = await ask('office_purchases', {
      kind: 'supplier_statement',
      partyKind: 'supplier',
      partyCode: supplierCode,
      docRef: null,
    });
    expect(ok.ok).toBe(true);
    expect(await refused(ask('plant_manager'))).toBe(true);
    expect(await refused(ask('office_sales', { partyCode: 'CLT-NOPE' }))).toBe(true);
    expect(await refused(ask('office_sales', { docRef: null }))).toBe(true);
  });
  it('the same request cannot wait twice', async () => {
    const first = await ask('accountant', { docRef: 'FA-2026-99999' });
    expect(first.ok).toBe(true);
    expect(await refused(ask('accountant', { docRef: 'FA-2026-99999' }))).toBe(true);
  });
  it('only the owner and app_admin decide; approval releases once, to the requester only', async () => {
    const r = await ask('office_sales', { kind: 'releve', docRef: null });
    if (!r.ok) throw new Error(r.error);
    expect(
      await refused(decideDocumentRequest(app, u.office_sales!, { id: r.value.id, approve: true })),
    ).toBe(true);
    expect((await listPendingDocumentRequests(app, u.app_admin!)).some((p) => p.id === r.value.id)).toBe(
      true,
    );
    expect((await decideDocumentRequest(app, u.app_admin!, { id: r.value.id, approve: true })).ok).toBe(true);
    // decided: not decidable again
    expect(await refused(decideDocumentRequest(app, u.owner!, { id: r.value.id, approve: false }))).toBe(
      true,
    );
    // not the requester: nothing
    expect(await refused(releaseDocumentRequest(app, u.accountant!, r.value.id))).toBe(true);
    const used = await releaseDocumentRequest(app, u.office_sales!, r.value.id);
    expect(used).toMatchObject({ ok: true, value: { kind: 'releve', partyCode: clientCode } });
    expect(await refused(releaseDocumentRequest(app, u.office_sales!, r.value.id))).toBe(true);
  });
  it('a document copy cannot be released by marking it used: only its download consumes the approval (F08)', async () => {
    const r = await ask('office_sales');
    if (!r.ok) throw new Error(r.error);
    expect((await decideDocumentRequest(app, u.owner!, { id: r.value.id, approve: true })).ok).toBe(true);
    expect(await refused(releaseDocumentRequest(app, u.office_sales!, r.value.id))).toBe(true);
    const mine = await listMyDocumentRequests(app, u.office_sales!);
    expect(mine.find((m) => m.id === r.value.id)?.status).toBe('approved');
  });
  it('a denied request releases nothing', async () => {
    const r = await ask('office_sales');
    if (!r.ok) throw new Error(r.error);
    expect((await decideDocumentRequest(app, u.owner!, { id: r.value.id, approve: false })).ok).toBe(true);
    expect(await refused(releaseDocumentRequest(app, u.office_sales!, r.value.id))).toBe(true);
  });
});

describe('invoice timing and numbering', () => {
  it('the accountant chooses the timing; sales cannot; an unknown timing is refused', async () => {
    expect((await setInvoiceTiming(app, u.accountant!, 'monthly')).ok).toBe(true);
    expect(await getInvoiceTiming(app, u.office_sales!)).toBe('monthly');
    expect(await refused(setInvoiceTiming(app, u.office_sales!, 'full_payment'))).toBe(true);
    expect(await refused(setInvoiceTiming(app, u.owner!, 'weekly'))).toBe(true);
    expect((await setInvoiceTiming(app, u.owner!, 'per_delivery')).ok).toBe(true);
  });
  it('the numbering continues from the last number and only moves forward', async () => {
    const year = 2900 + Math.floor(Math.random() * 90);
    expect((await setInvoiceSequence(app, u.owner!, { year, last: 1204 })).ok).toBe(true);
    const next = await withRlsContext(app, { userId: u.owner!.id, role: 'owner', requestId: marker }, (tx) =>
      tx.query<{ n: string }>(`select public.next_doc_number('FA', $1, 5) as n`, [year]),
    );
    expect(next.rows[0]?.n).toBe(`FA-${year}-01205`);
    expect(await refused(setInvoiceSequence(app, u.owner!, { year, last: 1100 }))).toBe(true);
    expect(await refused(setInvoiceSequence(app, u.accountant!, { year, last: 5000 }))).toBe(true);
  });
});

describe('the client copy is tied to its download (F08)', () => {
  const owner = () => ({ userId: u.owner!.id, role: 'owner' as const, requestId: marker });
  let quoteCode = '';
  let otherClientCode = '';
  beforeAll(async () => {
    const type = await createConcreteType(app, u.owner!, {
      code: `D${marker.slice(2, 8)}`,
      label: 'Béton copie',
    });
    if (!type.ok) throw new Error(type.error);
    const list = await createListPrice(app, u.owner!, {
      concreteTypeId: type.value.id,
      priceHtPerM3Centimes: 70_000,
      effectiveFrom: '2026-01-01',
    });
    if (!list.ok) throw new Error(list.error);
    const clientId = (
      await withRlsContext(app, owner(), (tx) =>
        tx.query<{ id: string }>('select id from client where code = $1', [clientCode]),
      )
    ).rows[0]!.id;
    const q = await createQuote(
      app,
      u.owner!,
      { clientId, concreteTypeId: type.value.id, volumeL: 5_000 },
      { today: '2026-06-01' },
    );
    if (!q.ok) throw new Error(q.error);
    quoteCode = q.value.code;
    otherClientCode = (
      await withRlsContext(app, owner(), (tx) =>
        tx.query<{ code: string }>(
          `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning code`,
          [`dvo${marker}`],
        ),
      )
    ).rows[0]!.code;
  });
  const approved = async (extra: Record<string, unknown> = {}) => {
    const r = await ask('office_sales', { kind: 'quote_copy', docRef: quoteCode, ...extra });
    if (!r.ok) throw new Error(r.error);
    const d = await decideDocumentRequest(app, u.owner!, { id: r.value.id, approve: true });
    if (!d.ok) throw new Error(d.error);
    return r.value.id;
  };
  const take = (who: string, id: string, kind = 'quote' as const, docRef = quoteCode) =>
    consumeDocumentCopy(app, u[who]!, { requestId: id, kind, docRef });

  it('an approved request releases its own document once, then never again', async () => {
    const id = await approved();
    expect(await take('office_sales', id)).toBe(true);
    expect(await take('office_sales', id)).toBe(false);
    expect((await listMyDocumentRequests(app, u.office_sales!)).find((m) => m.id === id)?.status).toBe(
      'used',
    );
  });
  it('two downloads at the same moment release it once', async () => {
    const id = await approved();
    const results = await Promise.all([
      take('office_sales', id),
      take('office_sales', id),
      take('office_sales', id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('a pending or denied request releases nothing', async () => {
    const r = await ask('accountant', { kind: 'quote_copy', docRef: quoteCode });
    if (!r.ok) throw new Error(r.error);
    expect(await take('accountant', r.value.id)).toBe(false); // still pending
    expect((await decideDocumentRequest(app, u.owner!, { id: r.value.id, approve: false })).ok).toBe(true);
    expect(await take('accountant', r.value.id)).toBe(false); // denied
  });
  it('only the requester, only for the approved document, kind and client', async () => {
    const id = await approved();
    expect(await take('accountant', id)).toBe(false); // not the requester
    expect(await take('office_sales', id, 'quote', 'DV-2026-99999')).toBe(false); // another document
    expect(await take('office_sales', id, 'avoir' as never)).toBe(false); // another kind
    expect(await take('office_sales', id)).toBe(true); // still intact after the refusals
    const wrongClient = await approved({ partyCode: otherClientCode });
    expect(await take('office_sales', wrongClient)).toBe(false); // the quote is not that client's
  });
  it('an approval expires after 24 hours', async () => {
    const id = await approved();
    const c = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    await c.connect();
    try {
      await c.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'owner', false)`, [
        u.owner!.id,
      ]);
      await c.query(`update document_request set decided_at = now() - interval '25 hours' where id = $1`, [
        id,
      ]);
    } finally {
      await c.end();
    }
    expect(await take('office_sales', id)).toBe(false);
    expect((await listMyDocumentRequests(app, u.office_sales!)).find((m) => m.id === id)?.status).toBe(
      'expired',
    );
  });
});
