import { formatCentimes } from '@/lib/money';
import { err, ok } from '@/lib/result';
import {
  computePurchaseTotals,
  createPurchase,
  parsePurchaseInput,
  type PurchaseError,
} from '@/modules/ledger';
import {
  listComponents,
  listPurchasePrices,
  listPurchaseUnits,
  resolvePurchasePrice,
} from '@/modules/master-data';
import { asDryRun, can, readParameters } from '@/modules/platform-security';
import { createPurchaseParams, type StoredDraft } from '../../domain/drafts';
import { sameName } from './resolve';
import { supplierByCode } from './resolve';
import type { DraftError, DraftTool, ExecContext, Prepared } from './types';

type Purchase = Extract<StoredDraft, { action: 'create_purchase' }>;

const mapError = (e: PurchaseError): DraftError =>
  e === 'NOT_FOUND' || e === 'SUPPLIER_ARCHIVED' ? 'NOT_FOUND' : 'INVALID';

async function purchaseInput(ctx: ExecContext, d: Purchase) {
  const supplier = await supplierByCode(ctx, d.supplier);
  const component = (await listComponents(ctx.appPool, ctx.actor)).find(
    (c) =>
      c.status === 'active' &&
      (sameName(c.nameFr, d.component) || sameName(c.nameAr, d.component) || c.code === d.component),
  );
  if (!supplier || !component) return null;
  const units = (await listPurchaseUnits(ctx.appPool, ctx.actor)).filter(
    (u) => u.componentId === component.id && u.status === 'active',
  );
  const unit = d.unit
    ? units.find((u) => sameName(u.label, d.unit as string))
    : units.length === 1
      ? units[0]
      : undefined;
  if (!unit) return null;
  const input = {
    supplierId: supplier.id,
    lines: [
      {
        componentId: component.id,
        purchaseUnitId: unit.id,
        qtyMilli: d.qtyMilli,
        unitPriceHtCentimes: d.unitPriceCentimes,
      },
    ],
    payable: 'invoice' as const,
  };
  return parsePurchaseInput(input).ok ? { supplier, component, unit, input } : null;
}

export const createPurchaseDraft: DraftTool<typeof createPurchaseParams> = {
  name: 'create_purchase',
  kind: 'draft',
  description:
    'Prepares a purchase order with a supplier (code) for a component (its name as the tools give it), a quantity in the purchase unit (given, or the only one the component has). The price is the supplier price in force, or the one the person stated as the reference of the question; never your own. The person checks and confirms.',
  params: createPurchaseParams,
  roles: ['owner', 'office'],
  permissions: ['purchases.write'],
  async prepare(ctx, a) {
    // The price: what the person typed (the form's own field), else the price in force for the roles that read purchase prices.
    let unitPrice: number | null = null;
    if (a.unit_price !== undefined) {
      const typed = ctx.ps.userAmount(a.unit_price);
      if (typeof typed !== 'number' || typed <= 0) return err('NEEDS_AMOUNT');
      unitPrice = typed;
    }
    const probe: Purchase = {
      action: 'create_purchase',
      supplier: a.supplier,
      component: a.component,
      unit: a.unit ?? null,
      qtyMilli: Math.round(a.quantity * 1000),
      unitPriceCentimes: unitPrice ?? 1,
    };
    const found = await purchaseInput(ctx, probe);
    if (!found) {
      // Distinguish a missing unit from an unknown supplier or component.
      const supplier = await supplierByCode(ctx, a.supplier);
      const component = (await listComponents(ctx.appPool, ctx.actor)).find(
        (c) =>
          c.status === 'active' &&
          (sameName(c.nameFr, a.component) || sameName(c.nameAr, a.component) || c.code === a.component),
      );
      return err(supplier && component ? 'NEEDS_UNIT' : 'NOT_FOUND');
    }
    if (unitPrice === null) {
      if (!can(ctx.actor.role, 'purchase_prices.read')) return err('NEEDS_PRICE');
      const prices = await listPurchasePrices(ctx.appPool, ctx.actor, found.component.id);
      const inForce = resolvePurchasePrice(
        prices
          .filter((p) => p.supplierId === found.supplier.id && p.purchaseUnitId === found.unit.id)
          .map((p) => ({ ...p, factorToBase: found.unit.factorToBase })),
        found.component.id,
        ctx.today,
      );
      if (!inForce.ok) return err('NEEDS_PRICE');
      unitPrice = inForce.value.priceHtCentimes;
    }
    const stored: Purchase = { ...probe, unit: found.unit.label, unitPriceCentimes: unitPrice };
    const resolved = await purchaseInput(ctx, stored);
    if (!resolved) return err('INVALID');
    const rehearsal = await asDryRun(() =>
      createPurchase(ctx.appPool, ctx.actor, resolved.input, { today: ctx.today }),
    );
    if (!rehearsal.ok) return err(mapError(rehearsal.error));
    const money = can(ctx.actor.role, 'purchases.read_money');
    const card: Prepared['card'] = {
      action: 'create_purchase',
      needsStepUp: true,
      blind: !money,
      fields: [
        { key: 'supplier', value: resolved.supplier.name },
        { key: 'component', value: resolved.component.nameFr },
        { key: 'quantity', value: `${a.quantity} ${resolved.unit.label}`, ltr: true },
      ],
      rows: [],
      notes: ['checkSupplier', 'checkQuantity'],
    };
    if (money) {
      const vat = (await readParameters(ctx.authPool))['vat_rate_bp'];
      const totals = computePurchaseTotals(resolved.input.lines, vat);
      if (!totals.ok) return err('INVALID');
      card.fields.push(
        { key: 'unitPrice', value: `${formatCentimes(stored.unitPriceCentimes)} MAD` },
        { key: 'totalHt', value: `${formatCentimes(totals.value.totalHt)} MAD` },
        { key: 'vat', value: `${formatCentimes(totals.value.totalVat)} MAD` },
        { key: 'totalTtc', value: `${formatCentimes(totals.value.totalTtc)} MAD` },
      );
      card.notes.push('checkPrice');
    }
    return ok({ stored, card });
  },
  async execute(ctx, stored) {
    if (stored.action !== 'create_purchase') return err('INVALID');
    const resolved = await purchaseInput(ctx, stored);
    if (!resolved) return err('STALE');
    const made = await createPurchase(ctx.appPool, ctx.actor, resolved.input, { today: ctx.today });
    return made.ok ? ok({ ref: made.value.code }) : err(mapError(made.error));
  },
};
