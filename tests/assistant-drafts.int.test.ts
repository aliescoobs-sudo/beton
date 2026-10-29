import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/lib/ai/fake-provider';
import type { LlmRequest, LlmResponse } from '../src/lib/ai/llm-provider';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { cipherFrom } from '../src/modules/assistant/service/cipher';
import { forgetLeakIndex, loadLeakIndex } from '../src/modules/assistant/service/leak-index';
import {
  confirmProposal,
  listProposals,
  rejectProposal,
  type ProposalDeps,
} from '../src/modules/assistant/service/proposals';
import { runTurn, type TurnDeps } from '../src/modules/assistant/service/turn';
import { DRAFT_TOOLS } from '../src/modules/assistant/service/drafts/registry';
import { DRAFT_ROLES, MONEY_ACTIONS, needsStepUp } from '../src/modules/assistant/domain/drafts';
import { createInvoice, createOrder, getInvoiceQueue, receiveInstrument } from '../src/modules/ledger';
import { createPurchasePrice } from '../src/modules/master-data';
import { recordLoss } from '../src/modules/operations';
import { can } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { defaultParameters } from '../src/modules/platform-security/domain/parameters';
import { verifyAuditChain } from '../src/modules/platform-security/service/audit-chain';
import { engineParams } from '../src/modules/rules-engine';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  clientWithLoads,
  deliveryScene,
  type DeliveryScene,
  newDelivery,
  orderMaster,
  type OrderMaster,
  moneyMaster,
  purchaseMaster,
  type PurchaseMaster,
} from './helpers/ledger-fixtures';

// assistant A7 (SPEC-assistant §5, §7): the five drafts and their confirmation. AC-ASSIST-10 to 13, 16, 19, 20.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
afterAll(() => Promise.all([app.end(), auth.end(), system.end(), migrator.end()]));

const cipher = cipherFrom(parseKeyring(`t1:${Buffer.alloc(32, 5).toString('base64')}`));
const hmacKey = Buffer.alloc(32, 6).toString('base64');
const ROLES = ['owner', 'partner', 'office', 'plant', 'support'] as const;
const marker = `ad${randomUUID()
  .replace(/-/g, '')
  .slice(0, 10)
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;
const TODAY = '2026-06-02';
const users = {} as Record<(typeof ROLES)[number], SessionUser>;
let scene: DeliveryScene;
let master: OrderMaster;
let pm: PurchaseMaster;
let typeCode: string;
let typeId: string;
let supplier: { code: string; name: string };
let component: { name: string };

const deps = (provider: FakeProvider): TurnDeps => ({
  appPool: app,
  authPool: auth,
  systemPool: system,
  provider,
  model: 'fake',
  cipher,
  hmacKey,
  today: TODAY,
  engine: engineParams(defaultParameters()),
  leakIndex: () => loadLeakIndex(system, cipher),
  // The owner is one person with twenty questions in ten minutes; this suite asks more. The gate has its own tests.
  gate: async () => ({ refusal: null, budgetPercent: 0 }),
});
const pdeps: ProposalDeps = { appPool: app, cipher, today: TODAY };

const tool = (id: string, name: string, args: unknown = {}) => ({ id, name, args });
const reply = (over: Partial<LlmResponse>): LlmResponse => ({
  text: null,
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  model: 'fake',
  ...over,
});
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

type Refs = { amt: string[]; num: string[] };
/** A turn in which the model answers the question with one draft tool call, built from the references of the masked question. */
async function draft(user: SessionUser, question: string, name: string, build: (refs: Refs) => unknown) {
  const provider = new FakeProvider((request: LlmRequest) => {
    if (request.messages.some((m) => m.role === 'tool'))
      return reply({ text: 'Voici le brouillon, à vérifier et confirmer.' });
    const q = request.messages.find((m) => m.role === 'user')?.content ?? '';
    return reply({
      toolCalls: [
        tool(
          'd1',
          name,
          build({ amt: q.match(/\{\{AMT_\d+\}\}/g) ?? [], num: q.match(/\{\{NUM_\d+\}\}/g) ?? [] }),
        ),
      ],
    });
  });
  forgetLeakIndex();
  const out = await runTurn(deps(provider), user, { question });
  return { out, provider, card: out.proposals[0] };
}

const countOf = async (user: SessionUser, table: string): Promise<number | null> => {
  try {
    return Number(
      (await inCtx(user, (tx) => tx.query(`select count(*)::int as n from "${table}"`))).rows[0].n,
    );
  } catch {
    return null;
  }
};
async function snapshot(): Promise<Map<string, number>> {
  const names = (
    await migrator.query<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname !~ '^__'
          and has_table_privilege('belgobeton_app', c.oid, 'SELECT')`,
    )
  ).rows.map((r) => r.t);
  const out = new Map<string, number>();
  for (const t of names) {
    if (t.startsWith('ai_') || t === 'audit_event') continue;
    const n = await countOf(users.owner, t);
    if (n !== null) out.set(t, n);
  }
  return out;
}

beforeAll(async () => {
  for (const role of ROLES) users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
  // The fixture names a client and a product the same: in this suite they must differ, or the leak scan rightly refuses a payload.
  await inCtx(users.owner, (tx) =>
    tx.query('update client set name = $2 where id = $1', [master.clientId, `mc${marker}`]),
  );
  // The pilot's own type B25 (the fixture's type has a random code, and a run of six digits in a payload is a leak by rule).
  const b25 = (
    await inCtx(users.owner, (tx) =>
      tx.query<{ id: string; code: string }>("select id, code from concrete_type where code = 'B25'"),
    )
  ).rows[0]!;
  typeCode = b25.code;
  typeId = b25.id;
  pm = await purchaseMaster(app, users.owner.id, marker);
  // The fixture gives its supplier and its component the same name: a name in a payload is a leak by rule, so they differ here.
  await inCtx(users.owner, (tx) =>
    tx.query('update supplier set name = $2 where id = $1', [pm.supplierId, `sp${marker}`]),
  );
  // A caisse, so that cash can be received.
  await moneyMaster(app, users.owner.id, marker);
  const s = (
    await inCtx(users.owner, (tx) =>
      tx.query<{ code: string; name: string }>('select code, name from supplier where id = $1', [
        pm.supplierId,
      ]),
    )
  ).rows[0]!;
  supplier = s;
  component = {
    name: (
      await inCtx(users.owner, (tx) =>
        tx.query<{ name_fr: string }>('select name_fr from component where id = $1', [pm.componentId]),
      )
    ).rows[0]!.name_fr,
  };
});

/** A client with delivered loads that no invoice carries, and its code and BLs. */
async function clientToInvoice(loads: number[] = [3000, 2000]) {
  const c = await clientWithLoads(app, users.owner.id, master, scene, [loads]);
  return {
    code: c.clientCode,
    clientId: c.clientId,
    blNos: c.orders[0]!.blNos,
    deliveryIds: c.orders[0]!.deliveryIds,
  };
}

describe('the matrix of the drafts (AC-ASSIST-03, 19)', () => {
  it('has the five actions, each on its row of the spec and holding the permission of the screen it mirrors', () => {
    expect(DRAFT_TOOLS.map((t) => t.name).sort()).toEqual([
      'create_purchase',
      'invoice_from_bls',
      'plan_order',
      'record_payment',
      'record_return',
    ]);
    for (const t of DRAFT_TOOLS) {
      expect([...t.roles].sort(), t.name).toEqual([...DRAFT_ROLES[t.name]].sort());
      for (const role of ROLES)
        expect(t.roles.includes(role), `${t.name} for ${role}`).toBe(t.permissions.some((p) => can(role, p)));
    }
    expect(DRAFT_ROLES.invoice_from_bls).toEqual(['owner', 'office']);
    expect([...MONEY_ACTIONS].sort()).toEqual([
      'create_purchase',
      'invoice_from_bls',
      'plan_order',
      'record_payment',
    ]);
    expect(needsStepUp('record_return')).toBe(false);
  });

  it('offers a role the draft tools of its row and refuses the others, audited, with no draft', async () => {
    for (const role of ROLES) {
      const provider = new FakeProvider(() => reply({ text: 'Rien.' }));
      await runTurn(deps(provider), users[role], { question: 'Bonjour' });
      const names = provider.requests[0]!.tools.map((t) => t.name);
      for (const t of DRAFT_TOOLS)
        expect(names.includes(t.name), `${t.name} for ${role}`).toBe(t.roles.includes(role));
    }
    const before = await countOf(users.support, 'ai_proposal');
    const r = await draft(users.support, 'Facture ces BL', 'invoice_from_bls', () => ({
      client: 'CLT-001',
      bl_numbers: ['BL-2026-00001'],
    }));
    expect(r.out.chips[0]).toMatchObject({ tool: 'invoice_from_bls', outcome: 'permission_denied' });
    expect(r.out.proposals).toEqual([]);
    expect(await countOf(users.support, 'ai_proposal')).toBe(before);
    const p = await draft(users.plant, 'Fais une commande', 'plan_order', () => ({
      client: 'CLT-001',
      type: 'B25',
      m3: 5,
      date: '2026-06-10',
    }));
    expect(p.out.chips[0]?.outcome).toBe('permission_denied');
  });

  it('has no field that a model could fill with a total, a VAT, a balance or an allocation (AC-ASSIST-16)', () => {
    for (const t of DRAFT_TOOLS) {
      const keys = Object.keys((t.params as unknown as { shape: Record<string, unknown> }).shape);
      for (const k of keys)
        expect(k, `${t.name}.${k}`).not.toMatch(/total|vat|tva|ttc|balance|solde|alloc|discount/i);
    }
  });
});

describe('a draft writes nothing to a business table (AC-ASSIST-10)', () => {
  it('leaves every business table, and the gapless numbers, exactly as they were', async () => {
    const target = await clientToInvoice();
    const first = await createInvoice(
      app,
      users.owner,
      { deliveryIds: (await clientToInvoice()).deliveryIds },
      { today: TODAY },
    );
    if (!first.ok) throw new Error(first.error);
    const returned = await newDelivery(app, users.owner.id, marker, scene, 700);
    const returnedBl = returned.blNo;
    const before = await snapshot();
    const q = 'ceci 8451237 de 45 000 dh';
    const cases: [SessionUser, string, string, (r: Refs) => unknown][] = [
      [
        users.owner,
        'Commande',
        'plan_order',
        () => ({ client: target.code, type: typeCode, m3: 7.5, date: '2026-06-10', plan: 'advance50' }),
      ],
      [
        users.office,
        'Commande',
        'plan_order',
        () => ({ client: target.code, type: typeCode, m3: 7.5, date: '2026-06-10' }),
      ],
      [
        users.owner,
        `Chèque ${q}`,
        'record_payment',
        (r) => ({
          client: target.code,
          method: 'cheque',
          amount: r.amt[0],
          number: r.num[0],
          written_date: '2026-06-05',
        }),
      ],
      [
        users.office,
        `Chèque ${q}`,
        'record_payment',
        (r) => ({
          client: target.code,
          method: 'cheque',
          amount: r.amt[0],
          number: r.num[0],
          written_date: '2026-06-05',
        }),
      ],
      [
        users.owner,
        'Achat à 1 450 dh',
        'create_purchase',
        (r) => ({ supplier: supplier.code, component: component.name, quantity: 30, unit_price: r.amt[0] }),
      ],
      [
        users.office,
        'Achat à 1 450 dh',
        'create_purchase',
        (r) => ({ supplier: supplier.code, component: component.name, quantity: 30, unit_price: r.amt[0] }),
      ],
      [users.plant, 'Retour', 'record_return', () => ({ bl: returnedBl, reason: 'rejected_by_client' })],
      [users.owner, 'Facture', 'invoice_from_bls', () => ({ client: target.code, bl_numbers: target.blNos })],
      [
        users.office,
        'Facture',
        'invoice_from_bls',
        () => ({ client: target.code, bl_numbers: target.blNos }),
      ],
    ];
    for (const [user, question, name, build] of cases) {
      const r = await draft(user, question, name, build);
      expect(r.out.proposals.length, `${name} by ${user.role}`).toBe(1);
      expect(r.out.chips[0], `${name} by ${user.role}`).toMatchObject({ outcome: 'ok' });
    }
    const after = await snapshot();
    const moved = [...after].filter(([t, n]) => before.get(t) !== n).map(([t]) => t);
    expect(moved).toEqual([]);
    // The numbers stay gapless: the next invoice is the one after the last real one.
    const next = await createInvoice(app, users.owner, { deliveryIds: target.deliveryIds }, { today: TODAY });
    if (!next.ok) throw new Error(next.error);
    expect(Number(next.value.number.split('-')[2]) - Number(first.value.number.split('-')[2])).toBe(1);
    const chain = await migrator.connect();
    try {
      expect(await verifyAuditChain(chain)).toMatchObject({ ok: true });
    } finally {
      chain.release();
    }
  });
});

describe('what the card shows (AC-ASSIST-13, 20)', () => {
  it('shows the owner the figures the services computed, and office none: no price, total, balance or amount', async () => {
    const target = await clientToInvoice();
    const owner = await draft(users.owner, 'Commande', 'plan_order', () => ({
      client: target.code,
      type: typeCode,
      m3: 7.5,
      date: '2026-06-10',
      plan: 'advance50',
    }));
    const keysOf = (c: { fields: { key: string }[] }) => c.fields.map((f) => f.key);
    expect(keysOf(owner.card!)).toEqual(expect.arrayContaining(['unitPrice', 'totalHt', 'vat', 'totalTtc']));
    expect(owner.card!.rows).toHaveLength(2);
    expect(owner.card!).toMatchObject({ blind: false, needsStepUp: true });
    const office = await draft(users.office, 'Commande', 'plan_order', () => ({
      client: target.code,
      type: typeCode,
      m3: 7.5,
      date: '2026-06-10',
      plan: 'advance50',
    }));
    expect(office.card).toMatchObject({ blind: true, needsStepUp: true, rows: [] });
    const text = JSON.stringify(office.card);
    expect(text).not.toMatch(/MAD|unitPrice|totalHt|totalTtc|vat|amount|balance/i);
    expect(office.out.outcome, office.out.leakKinds.join()).toBe('ok');
    expect(office.out.answer).toBeTruthy();
  });

  it('shows the owner the invoice as the database would make it, and office only BL numbers, m³ and product (AC-ASSIST-20)', async () => {
    const target = await clientToInvoice([3000, 2000]);
    const owner = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: target.code,
      bl_numbers: target.blNos,
    }));
    const rows = owner.card!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.map((f) => f.key)).toEqual(['product', 'volume', 'unitPrice', 'amountHt', 'bls']);
    expect(rows[0]!.find((f) => f.key === 'volume')?.value).toBe('5 m³');
    expect(owner.card!.fields.map((f) => f.key)).toEqual([
      'client',
      'totalHt',
      'vat',
      'totalTtc',
      'advance',
      'netToPay',
    ]);
    const office = await draft(users.office, 'Facture', 'invoice_from_bls', () => ({
      client: target.code,
      bl_numbers: target.blNos,
    }));
    expect(office.card!.blind).toBe(true);
    expect(office.card!.fields.map((f) => f.key)).toEqual(['client']);
    expect(office.card!.rows.map((r) => r.map((f) => f.key))).toEqual([
      ['bl', 'volume', 'product'],
      ['bl', 'volume', 'product'],
    ]);
    expect(JSON.stringify(office.card)).not.toMatch(/MAD|amount|price|total|vat|ttc|advance/i);
    for (const bl of target.blNos) expect(JSON.stringify(office.card)).toContain(bl);
  });

  it('puts what the owner typed on the payment card, and nothing of it on office’s', async () => {
    const target = await clientToInvoice();
    const made = await createInvoice(app, users.owner, { deliveryIds: target.deliveryIds }, { today: TODAY });
    if (!made.ok) throw new Error(made.error);
    const ask = 'Encaisse le chèque 8451237 de 45 000 dh';
    const owner = await draft(users.owner, ask, 'record_payment', (r) => ({
      client: target.code,
      method: 'cheque',
      amount: r.amt[0],
      number: r.num[0],
      written_date: '2026-06-05',
    }));
    expect(owner.card!.fields.find((f) => f.key === 'amount')?.value).toBe('45 000,00 MAD');
    expect(owner.card!.fields.find((f) => f.key === 'number')?.value).toBe('8451237');
    expect(owner.card!.fields.map((f) => f.key)).toContain('covers');
    const office = await draft(users.office, ask, 'record_payment', (r) => ({
      client: target.code,
      method: 'cheque',
      amount: r.amt[0],
      number: r.num[0],
      written_date: '2026-06-05',
    }));
    expect(office.card!.blind).toBe(true);
    expect(office.card!.fields.map((f) => f.key)).not.toContain('amount');
    expect(JSON.stringify(office.card)).not.toMatch(/MAD|45\s?000|covers|amount/);
    // And what the model saw of it: the references, not the figures.
    expect(JSON.stringify(office.provider.requests)).not.toMatch(/45 000|8451237/);
  });
});

describe('what a draft refuses (AC-ASSIST-07, 09)', () => {
  it('refuses an amount the model wrote itself, one it took from a tool result, and one that was never in the question', async () => {
    const target = await clientToInvoice();
    for (const amount of ['45000', '{{AMT_9}}', 'cinq mille']) {
      const r = await draft(users.owner, 'Chèque', 'record_payment', () => ({
        client: target.code,
        method: 'cash',
        amount,
      }));
      expect(r.out.proposals, amount).toEqual([]);
      expect(r.out.chips[0]?.outcome, amount).toBe('invalid_args');
    }
    // A tool's own placeholder is not an amount the person typed.
    const provider = new FakeProvider((request) => {
      if (request.messages.some((m) => m.role === 'tool' && m.name === 'open_invoices')) {
        const tm = request.messages.filter((m) => m.role === 'tool').at(-1)!.content;
        const placeholder = /\{\{AMT_\d+\}\}/.exec(tm)?.[0] ?? '{{AMT_1}}';
        return request.messages.some((m) => m.role === 'tool' && m.name === 'record_payment')
          ? reply({ text: 'Refusé.' })
          : reply({
              toolCalls: [
                tool('p', 'record_payment', { client: target.code, method: 'cash', amount: placeholder }),
              ],
            });
      }
      return reply({ toolCalls: [tool('o', 'open_invoices')] });
    });
    const out = await runTurn(deps(provider), users.owner, { question: 'Encaisse tout' });
    expect(out.proposals).toEqual([]);
  });

  it('refuses a cheque without its number or its written date, an unknown client, a price override from office', async () => {
    const target = await clientToInvoice();
    const noNumber = await draft(users.owner, 'Chèque de 45 000 dh', 'record_payment', (r) => ({
      client: target.code,
      method: 'cheque',
      amount: r.amt[0],
      written_date: '2026-06-05',
    }));
    expect(noNumber.out.proposals).toEqual([]);
    const unknown = await draft(users.owner, 'Commande', 'plan_order', () => ({
      client: 'CLT-9999',
      type: typeCode,
      m3: 5,
      date: '2026-06-10',
    }));
    expect(unknown.out.proposals).toEqual([]);
    const price = await draft(users.office, 'Commande à 900 dh le m³', 'plan_order', (r) => ({
      client: target.code,
      type: typeCode,
      m3: 5,
      date: '2026-06-10',
      price: r.amt[0],
    }));
    expect(price.out.proposals).toEqual([]);
    const past = await draft(users.owner, 'Commande', 'plan_order', () => ({
      client: target.code,
      type: typeCode,
      m3: 5,
      date: '2026-05-01',
    }));
    expect(past.out.proposals).toEqual([]);
  });

  it('refuses BLs that are not in the client’s invoicing queue: another client’s, undelivered, already invoiced', async () => {
    const a = await clientToInvoice();
    const b = await clientToInvoice();
    const undelivered = await clientWithLoads(app, users.owner.id, master, scene, [[1000]], {
      delivered: false,
    });
    const mixed = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: a.code,
      bl_numbers: [a.blNos[0], b.blNos[0]],
    }));
    expect(mixed.out.proposals).toEqual([]);
    const notDelivered = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: undelivered.clientCode,
      bl_numbers: undelivered.orders[0]!.blNos,
    }));
    expect(notDelivered.out.proposals).toEqual([]);
    const made = await createInvoice(app, users.owner, { deliveryIds: a.deliveryIds }, { today: TODAY });
    if (!made.ok) throw new Error(made.error);
    const invoiced = await draft(users.office, 'Facture', 'invoice_from_bls', () => ({
      client: a.code,
      bl_numbers: a.blNos,
    }));
    expect(invoiced.out.proposals).toEqual([]);
  });
});

describe('confirming a draft (AC-ASSIST-11, 12)', () => {
  it('needs a fresh second factor for every money draft, owner or office, and writes nothing without it', async () => {
    const target = await clientToInvoice();
    const calls: [SessionUser, string, string, (r: Refs) => unknown][] = [
      [
        users.owner,
        'Commande',
        'plan_order',
        () => ({ client: target.code, type: typeCode, m3: 2, date: '2026-06-10' }),
      ],
      [
        users.office,
        'Commande',
        'plan_order',
        () => ({ client: target.code, type: typeCode, m3: 2, date: '2026-06-10' }),
      ],
      [
        users.owner,
        'Chèque 8451237 de 1 000 dh',
        'record_payment',
        (r) => ({
          client: target.code,
          method: 'cheque',
          amount: r.amt[0],
          number: r.num[0],
          written_date: '2026-06-05',
        }),
      ],
      [
        users.office,
        'Espèces de 1 000 dh',
        'record_payment',
        (r) => ({ client: target.code, method: 'cash', amount: r.amt[0] }),
      ],
      [
        users.owner,
        'Achat à 1 450 dh',
        'create_purchase',
        (r) => ({ supplier: supplier.code, component: component.name, quantity: 3, unit_price: r.amt[0] }),
      ],
      [
        users.office,
        'Achat à 1 450 dh',
        'create_purchase',
        (r) => ({ supplier: supplier.code, component: component.name, quantity: 3, unit_price: r.amt[0] }),
      ],
      [
        users.owner,
        'Facture',
        'invoice_from_bls',
        () => ({ client: target.code, bl_numbers: [target.blNos[0]] }),
      ],
      [
        users.office,
        'Facture',
        'invoice_from_bls',
        () => ({ client: target.code, bl_numbers: [target.blNos[1]] }),
      ],
    ];
    for (const [user, q, name, build] of calls) {
      const d = await draft(user, q, name, build);
      expect(d.card, `${name} by ${user.role}`).toBeDefined();
      const before = await snapshot();
      const refused = await confirmProposal(pdeps, user, d.card!.id, { stepUpOk: false });
      expect(refused, `${name} by ${user.role}`).toEqual({ ok: false, error: 'STEP_UP_REQUIRED' });
      expect(await snapshot()).toEqual(before);
      expect((await listProposals(pdeps, user)).find((c) => c.id === d.card!.id)?.status).toBe('pending');
      const done = await confirmProposal(pdeps, user, d.card!.id, { stepUpOk: true });
      expect(done.ok, `${name} by ${user.role}`).toBe(true);
    }
  });

  it('confirms a return with no second factor, and it writes the loss and no money', async () => {
    const load = await newDelivery(app, users.owner.id, marker, scene, 900);
    const d = await draft(users.plant, 'Retour', 'record_return', () => ({
      bl: load.blNo,
      m3: 0.4,
      reason: 'quality',
    }));
    expect(d.card).toMatchObject({ needsStepUp: false, blind: false });
    const before = await snapshot();
    const done = await confirmProposal(pdeps, users.plant, d.card!.id, { stepUpOk: false });
    expect(done).toMatchObject({ ok: true, card: { status: 'confirmed', resultRef: load.blNo } });
    const after = await snapshot();
    expect([...after].filter(([t, n]) => before.get(t) !== n).map(([t]) => t)).toEqual(['delivery_loss']);
    const loss = await inCtx(users.owner, (tx) =>
      tx.query('select volume_l, reason from delivery_loss where delivery_id = $1', [load.id]),
    );
    expect(loss.rows).toEqual([{ volume_l: 400, reason: 'quality' }]);
  });

  it('runs the service as the human: the audit says ai_confirmed and names the proposal, and the proposal moves to confirmed', async () => {
    const target = await clientToInvoice();
    const d = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: target.code,
      bl_numbers: target.blNos,
    }));
    const done = await confirmProposal(pdeps, users.owner, d.card!.id, { stepUpOk: true });
    expect(done).toMatchObject({ ok: true, card: { status: 'confirmed' } });
    const number = (done as { ok: true; card: { resultRef: string } }).card.resultRef;
    expect(number).toMatch(/^FA-\d{4}-\d{5,}$/);
    const events = await migrator.query<{
      actor_kind: string;
      actor_user_id: string;
      table_name: string;
      request_id: string;
    }>(
      `select actor_kind, actor_user_id, table_name, request_id from audit_event where request_id like $1 order by id`,
      [`%|ai:${d.card!.id}`],
    );
    expect(events.rows.length).toBeGreaterThan(2);
    expect(
      events.rows.every((e) => e.actor_kind === 'ai_confirmed' && e.actor_user_id === users.owner.id),
    ).toBe(true);
    expect(events.rows.map((e) => e.table_name)).toEqual(
      expect.arrayContaining(['invoice', 'invoice_line', 'ai_proposal']),
    );
    const proposal = await inCtx(users.owner, (tx) =>
      tx.query('select status, result_ref from ai_proposal where id = $1', [d.card!.id]),
    );
    expect(proposal.rows[0]).toEqual({ status: 'confirmed', result_ref: number });
  });

  it('is confirmed once, by its owner only, and a second confirmation, another user, a refusal or an expiry changes nothing', async () => {
    const target = await clientToInvoice();
    const d = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: target.code,
      bl_numbers: target.blNos,
    }));
    expect(await confirmProposal(pdeps, users.office, d.card!.id, { stepUpOk: true })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await confirmProposal(pdeps, users.plant, d.card!.id, { stepUpOk: true })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await rejectProposal(pdeps, users.office, d.card!.id)).toEqual({ ok: false, error: 'NOT_FOUND' });
    const invoices = (await countOf(users.owner, 'invoice')) as number;
    const first = await confirmProposal(pdeps, users.owner, d.card!.id, { stepUpOk: true });
    expect(first.ok).toBe(true);
    expect(await confirmProposal(pdeps, users.owner, d.card!.id, { stepUpOk: true })).toEqual({
      ok: false,
      error: 'ALREADY_DECIDED',
    });
    expect(await rejectProposal(pdeps, users.owner, d.card!.id)).toEqual({
      ok: false,
      error: 'ALREADY_DECIDED',
    });
    expect(await countOf(users.owner, 'invoice')).toBe(invoices + 1);
    // Two clicks at once: one invoice.
    const second = await clientToInvoice();
    const e = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: second.code,
      bl_numbers: second.blNos,
    }));
    const raced = await Promise.all(
      [1, 2, 3].map(() => confirmProposal(pdeps, users.owner, e.card!.id, { stepUpOk: true })),
    );
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
    expect(await countOf(users.owner, 'invoice')).toBe(invoices + 2);
    // A refused draft is refused.
    const third = await clientToInvoice();
    const f = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: third.code,
      bl_numbers: third.blNos,
    }));
    expect(await rejectProposal(pdeps, users.owner, f.card!.id)).toMatchObject({
      ok: true,
      card: { status: 'rejected' },
    });
    expect(await confirmProposal(pdeps, users.owner, f.card!.id, { stepUpOk: true })).toEqual({
      ok: false,
      error: 'ALREADY_DECIDED',
    });
  });

  it('fails closed when the data moved under it, and says so: nothing is written', async () => {
    const target = await clientToInvoice();
    const d = await draft(users.office, 'Facture', 'invoice_from_bls', () => ({
      client: target.code,
      bl_numbers: target.blNos,
    }));
    // Somebody invoices them in the meantime.
    const made = await createInvoice(app, users.owner, { deliveryIds: target.deliveryIds }, { today: TODAY });
    if (!made.ok) throw new Error(made.error);
    const invoices = (await countOf(users.owner, 'invoice')) as number;
    const done = await confirmProposal(pdeps, users.office, d.card!.id, { stepUpOk: true });
    expect(done).toMatchObject({ ok: false, error: 'STALE' });
    expect(await countOf(users.owner, 'invoice')).toBe(invoices);
    expect((await listProposals(pdeps, users.office)).find((c) => c.id === d.card!.id)?.status).toBe(
      'failed',
    );
    // A return drafted, then recorded elsewhere.
    const load = await newDelivery(app, users.owner.id, marker, scene, 500);
    const r = await draft(users.plant, 'Retour', 'record_return', () => ({
      bl: load.blNo,
      reason: 'too_old',
    }));
    const rec = await recordLoss(app, users.owner, { deliveryId: load.id, volumeL: 500, reason: 'too_old' });
    expect(rec.ok).toBe(true);
    expect(await confirmProposal(pdeps, users.plant, r.card!.id, { stepUpOk: false })).toMatchObject({
      ok: false,
      error: 'STALE',
    });
  });

  it('does not confirm an expired draft', async () => {
    const target = await clientToInvoice();
    const d = await draft(users.owner, 'Facture', 'invoice_from_bls', () => ({
      client: target.code,
      bl_numbers: target.blNos,
    }));
    // The real draft lives 24 hours; a draft of the same kind that expires in a second is made the way the table lets a user make one.
    const sealed = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ params_enc: string; interaction_id: string }>(
          'select params_enc, interaction_id from ai_proposal where id = $1',
          [d.card!.id],
        ),
      )
    ).rows[0]!;
    const shortId = uuidv7(new Date());
    await inCtx(users.owner, (tx) =>
      tx.query(
        `insert into ai_proposal (id, interaction_id, user_id, role, action, params_enc, expires_at)
         values ($1, $2, $3, 'owner', 'invoice_from_bls', $4, now() + interval '1 second')`,
        [shortId, sealed.interaction_id, users.owner.id, sealed.params_enc],
      ),
    );
    await new Promise((r) => setTimeout(r, 1500));
    const invoices = (await countOf(users.owner, 'invoice')) as number;
    expect(await confirmProposal(pdeps, users.owner, shortId, { stepUpOk: true })).toEqual({
      ok: false,
      error: 'EXPIRED',
    });
    expect(await countOf(users.owner, 'invoice')).toBe(invoices);
  });
});

describe('the confirmed record is what the form would have made (AC-ASSIST-13, 20)', () => {
  it('invoice: the same stored fields as the invoicing queue from the same BLs, and office is told the number only', async () => {
    const viaAssistant = await clientToInvoice([3000, 2000, 1000]);
    const viaQueue = await clientToInvoice([3000, 2000, 1000]);
    const d = await draft(users.office, 'Facture', 'invoice_from_bls', () => ({
      client: viaAssistant.code,
      bl_numbers: viaAssistant.blNos,
    }));
    const done = await confirmProposal(pdeps, users.office, d.card!.id, { stepUpOk: true });
    expect(done).toMatchObject({ ok: true });
    const numberA = (done as { ok: true; card: { resultRef: string } }).card.resultRef;
    expect(JSON.stringify(done)).not.toMatch(/MAD|Centimes|amount|total/i);
    const control = await createInvoice(
      app,
      users.office,
      { deliveryIds: viaQueue.deliveryIds },
      { today: TODAY },
    );
    if (!control.ok) throw new Error(control.error);
    const stored = async (number: string) => {
      const inv = (
        await inCtx(users.owner, (tx) =>
          tx.query(
            `select total_ht_centimes::text as ht, total_vat_centimes::text as vat, total_ttc_centimes::text as ttc, due_date - invoice_date as term from invoice where number = $1`,
            [number],
          ),
        )
      ).rows[0];
      const lines = (
        await inCtx(users.owner, (tx) =>
          tx.query(
            `select l.volume_l, l.unit_price_ht_centimes::text as price, l.line_ht_centimes::text as total from invoice_line l join invoice i on i.id = l.invoice_id where i.number = $1 order by l.volume_l desc`,
            [number],
          ),
        )
      ).rows;
      return { inv, lines };
    };
    expect(await stored(numberA)).toEqual(await stored(control.value.number));
    // One invoice for the three BLs, one line per BL (a BL is on one invoice).
    expect((await stored(numberA)).lines).toHaveLength(3);
    expect(
      (await getInvoiceQueue(app, users.owner)).find((c) => c.clientCode === viaAssistant.code),
    ).toBeUndefined();
  });

  it('order: the same stored fields as the form from the same inputs, office or owner', async () => {
    const target = await clientToInvoice();
    for (const user of [users.owner, users.office] as const) {
      const d = await draft(user, 'Commande', 'plan_order', () => ({
        client: target.code,
        type: typeCode,
        m3: 7.5,
        date: '2026-06-10',
        plan: 'cheque30',
      }));
      const done = await confirmProposal(pdeps, user, d.card!.id, { stepUpOk: true });
      expect(done.ok, user.role).toBe(true);
      const code = (done as { ok: true; card: { resultRef: string } }).card.resultRef;
      const control = await createOrder(
        app,
        user,
        {
          clientId: target.clientId,
          siteId: null,
          zoneId: null,
          concreteTypeId: typeId,
          volumeL: 7500,
          deliveryDate: '2026-06-10',
          plan: { preset: 'cheque30' },
        },
        { today: TODAY },
      );
      if (!control.ok) throw new Error(control.error);
      const fields = async (c: string) => {
        const o = (
          await inCtx(users.owner, (tx) =>
            tx.query(
              `select client_id, concrete_type_id, volume_l, delivery_date::text as d, unit_price_ht_centimes::text as p, vat_rate_bp, total_ht_centimes::text as ht, total_ttc_centimes::text as ttc, zone_id from sales_order where code = $1`,
              [c],
            ),
          )
        ).rows[0];
        const items = (
          await inCtx(users.owner, (tx) =>
            tx.query(
              `select i.method, i.due_date::text as due, i.amount_centimes::text as amount from payment_plan_item i join sales_order o on o.id = i.order_id where o.code = $1 order by i.seq`,
              [c],
            ),
          )
        ).rows;
        return { o, items };
      };
      expect(await fields(code), user.role).toEqual(await fields(control.value.code));
    }
  });

  it('payment: the same stored fields as the form, and the oldest invoices are covered first', async () => {
    const target = await clientToInvoice([3000]);
    const made = await createInvoice(app, users.owner, { deliveryIds: target.deliveryIds }, { today: TODAY });
    if (!made.ok) throw new Error(made.error);
    const d = await draft(users.office, 'Espèces de 1 000 dh', 'record_payment', (r) => ({
      client: target.code,
      method: 'cash',
      amount: r.amt[0],
    }));
    const done = await confirmProposal(pdeps, users.office, d.card!.id, { stepUpOk: true });
    expect(done.ok).toBe(true);
    expect(JSON.stringify(done)).not.toMatch(/MAD|1 000|1000/);
    const control = await receiveInstrument(
      app,
      users.office,
      { clientId: target.clientId, method: 'cash', amountCentimes: 100_000, allocateToClient: true },
      { today: TODAY },
    );
    expect(control.ok).toBe(true);
    const rows = (
      await inCtx(users.owner, (tx) =>
        tx.query(
          `select method, amount_centimes::text as a, number, received_date::text as d, (select coalesce(sum(amount_centimes),0)::text from allocation where instrument_id = i.id) as covered from payment_instrument i where client_id = $1 order by created_at`,
          [target.clientId],
        ),
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[0]).toMatchObject({ method: 'cash', a: '100000', covered: '100000' });
  });

  it('purchase: the supplier price in force when the person typed none, never a price of the model', async () => {
    const priced = await createPurchasePrice(app, users.owner, {
      componentId: pm.componentId,
      supplierId: pm.supplierId,
      purchaseUnitId: pm.unitId,
      priceHtCentimes: 145_000,
      effectiveFrom: '2026-01-01',
    });
    expect(priced.ok).toBe(true);
    const d = await draft(users.owner, 'Commande 30 t de ciment', 'create_purchase', () => ({
      supplier: supplier.code,
      component: component.name,
      quantity: 30,
    }));
    expect(d.card?.fields.find((f) => f.key === 'unitPrice')?.value).toBe('1 450,00 MAD');
    expect(d.card?.fields.find((f) => f.key === 'totalHt')?.value).toBe('43 500,00 MAD');
    const done = await confirmProposal(pdeps, users.owner, d.card!.id, { stepUpOk: true });
    expect(done).toMatchObject({ ok: true });
    const code = (done as { ok: true; card: { resultRef: string } }).card.resultRef;
    const row = (
      await inCtx(users.owner, (tx) =>
        tx.query(
          `select total_ht_centimes::text as ht, total_ttc_centimes::text as ttc from purchase where code = $1`,
          [code],
        ),
      )
    ).rows[0];
    expect(row).toEqual({ ht: '4350000', ttc: '5220000' });
    // Office has no price in force to read: with no price typed, no draft.
    const none = await draft(users.office, 'Commande 30 t de ciment', 'create_purchase', () => ({
      supplier: supplier.code,
      component: component.name,
      quantity: 30,
    }));
    expect(none.out.proposals).toEqual([]);
  });
});

describe('the drafts of a person are theirs', () => {
  it('lists a person’s own drafts only, newest first', async () => {
    const target = await clientToInvoice();
    const mine = await draft(users.office, 'Facture', 'invoice_from_bls', () => ({
      client: target.code,
      bl_numbers: target.blNos,
    }));
    expect((await listProposals(pdeps, users.office)).map((c) => c.id)).toContain(mine.card!.id);
    for (const other of [users.owner, users.plant, users.partner, users.support])
      expect(
        (await listProposals(pdeps, other)).map((c) => c.id),
        other.role,
      ).not.toContain(mine.card!.id);
  });

  it('stores the card sealed, with no readable amount in the table', async () => {
    const d = await draft(users.owner, 'Chèque 8451237 de 45 000 dh', 'record_payment', (r) => ({
      client: (r.amt, 'CLT-001'),
      method: 'cash',
      amount: r.amt[0],
    }));
    const rows = await inCtx(users.owner, (tx) =>
      tx.query<{ params_enc: string }>('select params_enc from ai_proposal order by created_at desc limit 5'),
    );
    for (const r of rows.rows) expect(r.params_enc ?? '').not.toMatch(/MAD|8451237|45\s?000/);
    expect(d.out.chips).toHaveLength(1);
  });
});
