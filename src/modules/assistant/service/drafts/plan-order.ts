import { formatCentimes } from '@/lib/money';
import { err, ok } from '@/lib/result';
import { createOrder, type OrderError, previewOrder } from '@/modules/ledger';
import { can, asDryRun } from '@/modules/platform-security';
import { listSelectableConcreteTypes } from '@/modules/master-data';
import { addDaysIso } from '@/modules/ledger';
import { planOrderParams, type StoredDraft } from '../../domain/drafts';
import { litresToM3 } from '../../domain/units';
import { clientByCode, siteByCode } from './resolve';
import type { DraftError, DraftTool, ExecContext, Prepared } from './types';

const PRICE_REASON = "Prix indiqué dans la demande faite à l'assistant, confirmé par le propriétaire.";

const mapOrderError = (e: OrderError): DraftError =>
  e === 'NOT_FOUND' || e === 'CLIENT_ARCHIVED' || e === 'TYPE_INACTIVE'
    ? 'NOT_FOUND'
    : e === 'FORBIDDEN_OVERRIDE'
      ? 'NOT_ALLOWED'
      : 'INVALID';

type PlanOrder = Extract<StoredDraft, { action: 'plan_order' }>;

/** The order input of the form, resolved from the codes of the draft by the person's own services. */
async function orderInput(ctx: ExecContext, d: PlanOrder) {
  const client = await clientByCode(ctx, d.client);
  const type = (await listSelectableConcreteTypes(ctx.appPool, ctx.actor)).find(
    (t) => t.code.toUpperCase() === d.type.toUpperCase(),
  );
  if (!client || !type) return null;
  let siteId: string | null = null;
  if (d.site) {
    const site = await siteByCode(ctx, d.site);
    if (!site || site.clientCode !== d.client) return null;
    siteId = site.id;
  }
  return {
    client,
    type,
    input: {
      clientId: client.id,
      siteId,
      zoneId: null,
      concreteTypeId: type.id,
      volumeL: d.volumeL,
      deliveryDate: d.date,
      plan: { preset: d.plan },
      ...(d.unitPriceCentimes !== null
        ? { priceOverride: { unitPriceHtCentimes: d.unitPriceCentimes, reason: PRICE_REASON } }
        : {}),
    },
  };
}

export const planOrder: DraftTool<typeof planOrderParams> = {
  name: 'plan_order',
  kind: 'draft',
  description:
    'Prepares an order for a client (code), a concrete type code (like B25), a volume in m³, a delivery date (YYYY-MM-DD), optionally a site code and a payment plan (cash, advance50, installments3, cheque30). A price only if the person stated one, as the reference of the question. The person checks and confirms; nothing is created before.',
  params: planOrderParams,
  roles: ['owner', 'office'],
  permissions: ['orders.write'],
  async prepare(ctx, a) {
    if (a.date < ctx.today || a.date > addDaysIso(ctx.today, 400)) return err('INVALID');
    let unitPriceCentimes: number | null = null;
    if (a.price !== undefined) {
      // A price other than the one in force is the owner's alone (orders.price_override) and is what the person typed.
      if (!can(ctx.actor.role, 'orders.price_override')) return err('NOT_ALLOWED');
      const typed = ctx.ps.userAmount(a.price);
      if (typeof typed !== 'number' || typed <= 0) return err('NEEDS_AMOUNT');
      unitPriceCentimes = typed;
    }
    const stored: PlanOrder = {
      action: 'plan_order',
      client: a.client,
      type: a.type.toUpperCase(),
      volumeL: Math.round(a.m3 * 1000),
      date: a.date,
      site: a.site ?? null,
      plan: a.plan ?? 'cash',
      unitPriceCentimes,
    };
    const resolved = await orderInput(ctx, stored);
    if (!resolved) return err('NOT_FOUND');
    const money = can(ctx.actor.role, 'orders.read_money');
    const base: Prepared['card'] = {
      action: 'plan_order',
      needsStepUp: true,
      blind: !money,
      fields: [
        { key: 'client', value: resolved.client.name },
        { key: 'product', value: `${resolved.type.code} · ${resolved.type.label}`, ltr: true },
        { key: 'volume', value: `${litresToM3(stored.volumeL)} m³`, ltr: true },
        { key: 'date', value: stored.date, ltr: true },
        ...(stored.site ? [{ key: 'site', value: stored.site, ltr: true }] : []),
        { key: 'plan', value: stored.plan, enumOf: 'plan' as const },
      ],
      rows: [],
      notes: ['checkClient', 'checkDate'],
    };
    if (money) {
      // Every figure comes from the service of the form: the price in force (or the one the person stated), the totals, the plan.
      const preview = await previewOrder(ctx.appPool, ctx.actor, resolved.input, { today: ctx.today });
      if (!preview.ok) return err(mapOrderError(preview.error));
      const p = preview.value;
      base.fields.push(
        { key: 'unitPrice', value: `${formatCentimes(p.unitPriceHtCentimes)} MAD` },
        { key: 'totalHt', value: `${formatCentimes(p.totalHtCentimes)} MAD` },
        { key: 'vat', value: `${formatCentimes(p.totalVatCentimes)} MAD` },
        { key: 'totalTtc', value: `${formatCentimes(p.totalTtcCentimes)} MAD` },
      );
      base.rows = p.plan.map((i) => [
        { key: 'method', value: i.method, enumOf: 'method' as const },
        { key: 'dueDate', value: i.dueDate, ltr: true },
        { key: 'amount', value: `${formatCentimes(i.amountCentimes)} MAD` },
      ]);
      if (unitPriceCentimes !== null) base.notes.push('checkPriceOverride');
    } else {
      // Blind entry: the form's own answer to a draft that could not be made (an archived client, a type out of use), and no figure.
      const rehearsal = await asDryRun(() =>
        createOrder(ctx.appPool, ctx.actor, resolved.input, { today: ctx.today }),
      );
      if (!rehearsal.ok) return err(mapOrderError(rehearsal.error));
    }
    return ok({ stored, card: base });
  },
  async execute(ctx, stored) {
    if (stored.action !== 'plan_order') return err('INVALID');
    const resolved = await orderInput(ctx, stored);
    if (!resolved) return err('STALE');
    const made = await createOrder(ctx.appPool, ctx.actor, resolved.input, { today: ctx.today });
    return made.ok ? ok({ ref: made.value.code }) : err(mapOrderError(made.error));
  },
};
