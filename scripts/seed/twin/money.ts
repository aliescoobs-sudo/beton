// T20 item 3: the money of the twin. Every payment goes through the application's own services as the owner (receive a cheque, allocate it to the plan item it pays, deposit,
// clear or bounce it; issue a cheque or LCN to a supplier against its purchase), so RBAC, the instrument events, the allocations and the single signed money movement are the
// real ones. The stories (who pays when, how late) come from plan-money.ts and give balances in every aging bucket. Also here: a payment above the upper limit waiting in the
// owner's approvals inbox, one in the middle band waiting for the Responsable, the charges register (with and without a supporting document) and the cash and bank accounts.
import { randomUUID } from 'node:crypto';
import { withRlsContext } from '../../../src/lib/db/rls-context.ts';
import {
  allocate,
  bounceInstrument,
  clearInstrument,
  createMoneyAccount,
  depositInstruments,
  issueInstrument,
  markChargePaid,
  preparePayment,
  receiveInstrument,
  recordCharge,
  setOpeningBalance,
} from '../../../src/modules/ledger/index.ts';
import { SYSTEM_ACTOR_ID, inRequest } from '../../../src/modules/platform-security/index.ts';
import { type TwinContext, addDays, must } from './context.ts';
import { type PlanItem, type Story, planClientPayment, planSupplierPayment } from './plan-money.ts';
import type { World } from './structure.ts';

export interface MoneyResult {
  clientPayments: number;
  supplierPayments: number;
  bounced: number;
  charges: number;
  requests: number;
}

const BANKS = ['Banque Atlas (fictive)', 'Banque du Rif (fictive)'];

export async function buildMoney(ctx: TwinContext, world: World): Promise<MoneyResult> {
  const { app, seed } = ctx.pools;
  const { owner, anchor, rng } = ctx;
  const out: MoneyResult = { clientPayments: 0, supplierPayments: 0, bounced: 0, charges: 0, requests: 0 };

  // Our own (fictitious) legal identity, so that the documents print with their mentions.
  await withRlsContext(
    seed,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'twin-seed-company' },
    async (tx) => {
      const has = await tx.query('select 1 from company_profile limit 1');
      if (has.rows.length === 0)
        await tx.query(
          `insert into company_profile (id, effective_from, legal_name, legal_form, ice, if_number, rc_number, patente, address, phone, email, rib, created_by)
         values ($1, '2026-01-01', 'KAYAS JUMEAU (fictif)', 'SARL', '000000000000089', '00000000', 'TET-00000', '00000000', 'Zone industrielle, Tétouan (fictif)', '0000 00 0000', 'contact@kayas.test', '000000000000000000000000', $2)`,
          [randomUUID(), SYSTEM_ACTOR_ID],
        );
    },
  );

  const caisse = must(
    'cash account',
    await createMoneyAccount(app, owner, { kind: 'cash', label: 'Caisse principale (fictif)' }),
  );
  const banks = [
    must(
      'bank A',
      await createMoneyAccount(app, owner, {
        kind: 'bank',
        label: 'Compte courant Banque Atlas (fictif)',
        bankName: BANKS[0],
      }),
    ),
    must(
      'bank B',
      await createMoneyAccount(app, owner, {
        kind: 'bank',
        label: 'Compte courant Banque du Rif (fictif)',
        bankName: BANKS[1],
      }),
    ),
  ];
  void caisse;
  let paper = 0;
  const number = (prefix: string) => `${prefix}${String(100_000 + ++paper)}`;

  // ---- clients -----------------------------------------------------------------------------------------------------------------
  const items = (
    await inRequest(app, owner, (tx) =>
      tx.query<{
        id: string;
        client_id: string;
        method: string;
        due: string;
        amount: string;
        delivery: string;
      }>(
        `select i.id, o.client_id, i.method, to_char(i.due_date, 'YYYY-MM-DD') as due, i.amount_centimes::text as amount, to_char(o.delivery_date, 'YYYY-MM-DD') as delivery
           from payment_plan_item i join sales_order o on o.id = i.order_id
          where i.reverses_id is null and o.reverses_id is null and not exists (select 1 from sales_order r where r.reverses_id = o.id)
          order by o.order_date, o.code, i.seq`,
      ),
    )
  ).rows;
  const byClient = new Map(world.clients.map((c) => [c.id, c]));
  interface Pay {
    story: Story;
    clientId: string;
    bank: string;
    account: string;
  }
  const pays: Pay[] = [];
  for (const it of items) {
    const client = byClient.get(it.client_id)!;
    const item: PlanItem = {
      itemId: it.id,
      method: it.method,
      due: it.due,
      amount: Number(it.amount),
      deliveryDate: it.delivery,
    };
    const story = planClientPayment(item, client.spec.behaviour, rng, anchor);
    if (!story) continue;
    const k = Number(client.code.replace(/\D/g, '')) % 2;
    pays.push({ story, clientId: client.id, bank: BANKS[k]!, account: banks[k]!.id });
  }
  // One bounced cheque: a cheque of a good client, deposited at least ten days ago, large enough to matter.
  const bounced = pays.find(
    (p) =>
      p.story.method === 'cheque' &&
      p.story.deposit &&
      p.story.deposit <= addDays(anchor, -10) &&
      p.story.amount >= 2_000_000 &&
      byClient.get(p.clientId)!.spec.behaviour === 'good',
  );
  if (bounced) {
    bounced.story.bounce = addDays(bounced.story.deposit!, 3);
    bounced.story.clear = null;
  }
  pays.sort((a, b) => a.story.received.localeCompare(b.story.received));
  for (const p of pays) {
    const s = p.story;
    const isPaper = s.method === 'cheque' || s.method === 'lcn';
    const ref = must(
      `receive ${s.itemId}`,
      await receiveInstrument(
        app,
        owner,
        {
          clientId: p.clientId,
          method: s.method,
          amountCentimes: s.amount,
          ...(isPaper
            ? { number: number(s.method === 'lcn' ? 'LCN' : 'CHQ'), bank: p.bank, writtenDate: s.written! }
            : s.method === 'transfer'
              ? { number: number('VIR'), bank: p.bank }
              : {}),
        },
        { today: s.received, ...(s.dueDate ? { dueDate: s.dueDate } : {}) },
      ),
    );
    must(
      `allocate ${s.itemId}`,
      await allocate(app, owner, { instrumentId: ref.id, itemId: s.itemId, amountCentimes: s.amount }),
    );
    if (s.deposit)
      must(
        'deposit',
        await depositInstruments(app, owner, {
          instrumentIds: [ref.id],
          accountId: p.account,
          date: s.deposit,
        }),
      );
    if (s.bounce) {
      must(
        'bounce',
        await bounceInstrument(app, owner, { instrumentId: ref.id, date: s.bounce, feeCentimes: 3_500 }),
      );
      out.bounced += 1;
    } else if (s.clear)
      must(
        'clear',
        await clearInstrument(app, owner, { instrumentId: ref.id, accountId: p.account, date: s.clear }),
      );
    out.clientPayments += 1;
  }
  // One credit nobody has allocated: a client's transfer received on account, cleared, covering nothing yet.
  const advance = world.clients.find((c) => c.spec.name.startsWith('Groupe Cap Spartel'))!;
  const credit = must(
    'credit',
    await receiveInstrument(
      app,
      owner,
      {
        clientId: advance.id,
        method: 'transfer',
        amountCentimes: 4_500_000,
        number: number('VIR'),
        bank: BANKS[0],
      },
      { today: addDays(anchor, -5) },
    ),
  );
  must(
    'clear credit',
    await clearInstrument(app, owner, {
      instrumentId: credit.id,
      accountId: banks[0]!.id,
      date: addDays(anchor, -5),
    }),
  );
  out.clientPayments += 1;

  // ---- suppliers ---------------------------------------------------------------------------------------------------------------
  const supplierItems = (
    await inRequest(app, owner, (tx) =>
      tx.query<{
        id: string;
        supplier_id: string;
        code: string;
        method: string;
        due: string;
        amount: string;
        order_date: string;
      }>(
        `select i.id, p.supplier_id, p.code, i.method, to_char(i.due_date, 'YYYY-MM-DD') as due, i.amount_centimes::text as amount, to_char(p.order_date, 'YYYY-MM-DD') as order_date
           from purchase_plan_item i join purchase p on p.id = i.purchase_id
          where i.reverses_id is null and p.reverses_id is null and not exists (select 1 from purchase r where r.reverses_id = p.id)
          order by p.order_date, p.code, i.seq`,
      ),
    )
  ).rows;
  interface Out {
    story: Story;
    supplierId: string;
    code: string;
    account: string;
    bank: string;
  }
  const outs: Out[] = [];
  for (const it of supplierItems) {
    const story = planSupplierPayment(
      {
        itemId: it.id,
        method: it.method,
        due: it.due,
        amount: Number(it.amount),
        deliveryDate: it.order_date,
      },
      rng,
      anchor,
    );
    if (!story) continue;
    const k = outs.length % 2;
    outs.push({ story, supplierId: it.supplier_id, code: it.code, account: banks[k]!.id, bank: BANKS[k]! });
  }
  outs.sort((a, b) => a.story.received.localeCompare(b.story.received));
  for (const o of outs) {
    const s = o.story;
    const ref = must(
      `issue ${o.code}`,
      await issueInstrument(
        app,
        owner,
        {
          supplierId: o.supplierId,
          method: s.method,
          amountCentimes: s.amount,
          purchaseCode: o.code,
          ...(s.method === 'transfer'
            ? { number: number('VIR'), bank: o.bank }
            : { number: number(s.method === 'lcn' ? 'LCN' : 'CHQ'), bank: o.bank, writtenDate: s.written! }),
        },
        { today: s.received, ...(s.dueDate ? { dueDate: s.dueDate } : {}) },
      ),
    );
    if (s.clear)
      must(
        'clear out',
        await clearInstrument(app, owner, { instrumentId: ref.id, accountId: o.account, date: s.clear }),
      );
    out.supplierPayments += 1;
  }

  // ---- payments waiting for a decision (D247) ----------------------------------------------------------------------------------
  const cement = world.suppliers.find((x) => x.name.startsWith('Ciments du Nord'))!;
  const transport = world.suppliers.find((x) => x.name.startsWith('Transports'))!;
  must(
    'request above the upper limit',
    await preparePayment(ctx.pools.app, ctx.purchases, {
      supplierId: cement.id,
      method: 'transfer',
      amount: '72000,00',
      note: 'Règlement partiel des livraisons de novembre (fictif)',
    }),
  );
  must(
    'request in the middle band',
    await preparePayment(ctx.pools.app, ctx.purchases, {
      supplierId: transport.id,
      method: 'cheque',
      amount: '2800,00',
      number: number('CHQ'),
      bank: BANKS[0],
      writtenDate: addDays(anchor, 2),
      note: 'Transport de la semaine (fictif)',
    }),
  );
  out.requests = 2;

  // ---- charges register --------------------------------------------------------------------------------------------------------
  const charges: [string, string, string, number, number, string, string | null][] = [
    // date offset from the anchor, beneficiary, category, HT, VAT, mode, supporting document
    ['-70', 'Bailleur du dépôt (fictif)', 'rent', 450_000, 0, 'transfer', 'QUITT-0911'],
    ['-40', 'Bailleur du dépôt (fictif)', 'rent', 450_000, 0, 'transfer', 'QUITT-1011'],
    ['-10', 'Bailleur du dépôt (fictif)', 'rent', 450_000, 0, 'transfer', 'QUITT-1111'],
    [
      '-55',
      'Régie eau et électricité (fictif)',
      'electricity_water',
      1_250_000,
      250_000,
      'transfer',
      'FAC-EE-0922',
    ],
    [
      '-25',
      'Régie eau et électricité (fictif)',
      'electricity_water',
      1_410_000,
      282_000,
      'transfer',
      'FAC-EE-1022',
    ],
    ['-33', 'Opérateur télécom (fictif)', 'telecom', 82_000, 16_400, 'card', 'FAC-TEL-1033'],
    ['-60', 'Assurances du Nord (fictif)', 'insurance', 640_000, 0, 'cheque', 'POL-2026-077'],
    ['-48', 'Garage Mécanique Rif (fictif)', 'maintenance', 183_000, 36_600, 'cash', 'BON-0481'],
    ['-12', 'Garage Mécanique Rif (fictif)', 'maintenance', 62_000, 12_400, 'cash', null],
    ['-7', 'Papeterie du Centre (fictif)', 'supplies', 23_500, 4_700, 'cash', null],
    ['-3', 'Café et eau pour le bureau (fictif)', 'supplies', 9_800, 0, 'cash', null],
    ['-20', 'Banque Atlas (fictive)', 'bank_fees', 14_500, 0, 'transfer', 'RELEVE-1020'],
    ['-30', 'Taxi de livraison urgente (fictif)', 'transport', 18_000, 0, 'cash', 'TICKET-30'],
    ['-5', 'Plombier de dépannage (fictif)', 'maintenance', 45_000, 9_000, 'cash', 'BON-0512'],
  ];
  for (const [offset, beneficiary, category, ht, vat, mode, doc] of charges) {
    const recorded = must(
      `charge ${beneficiary}`,
      await recordCharge(app, ctx.purchases, {
        date: addDays(anchor, Number(offset)),
        beneficiary,
        category,
        ht: (ht / 100).toFixed(2),
        vat: (vat / 100).toFixed(2),
        mode,
        ...(doc ? { documentRef: doc } : {}),
      }),
    );
    // the small ones are paid at once (a payment without its document is flagged, by the application)
    if (ht + vat < 100_000)
      must('charge paid', await markChargePaid(app, ctx.purchases, { id: recorded.id }));
    out.charges += 1;
  }

  // ---- cash and bank openings: enough that no account ever goes below zero ----------------------------------------------------
  const accounts = await ctx.pools.migrator.query<{ id: string; low: string }>(
    `select a.id, coalesce(min(c.run), 0)::text as low from money_account a left join (
        select account_id, sum(sum(amount_centimes)) over (partition by account_id order by movement_date) as run from money_movement group by account_id, movement_date
     ) c on c.account_id = a.id group by a.id`,
  );
  for (const a of accounts.rows) {
    const need = Math.max(0, -Number(a.low));
    const base = a.id === caisse.id ? 1_500_000 : 20_000_000;
    must(
      'opening balance',
      await setOpeningBalance(app, owner, {
        accountId: a.id,
        asOf: '2026-08-31',
        amountCentimes: need + base,
        note: 'Solde au démarrage de la période (fictif)',
      }),
    );
  }
  return out;
}
