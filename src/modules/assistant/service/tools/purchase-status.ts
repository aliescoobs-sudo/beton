import { z } from 'zod';
import { getSupplierInvoiceMatch, listPurchases, listSupplierInvoices } from '@/modules/ledger';
import { listReceivable } from '@/modules/operations';
import { can } from '@/modules/platform-security';
import type { AssistantTool } from '../../domain/tool-types';

const PO_CODE = z.string().regex(/^ACH-\d{4}-\d{5,}$/, 'a purchase order code like ACH-2026-00012');
const milli = (n: number): number => Math.round(n) / 1000;

const line = z.object({
  name: z.string(),
  unit: z.string(),
  orderedQty: z.number(),
  receivedQty: z.number(),
});
const invoice = z.object({
  code: z.string(),
  state: z.string(),
  gapLines: z.number().int(),
  flags: z.array(z.string()),
  totalCentimes: z.number().int(),
});

const purchase = (money: boolean) =>
  z.object({
    code: z.string(),
    supplier: z.string(),
    orderDate: z.string(),
    status: z.enum(['expected', 'partial', 'complete']),
    cancelled: z.boolean(),
    lines: z.array(line),
    // The supplier invoice and its match, and the amounts: owner and support only. For the plant there is no such key.
    ...(money
      ? {
          invoices: z.array(invoice),
          totalCentimes: z.number().int().optional(),
          paidCentimes: z.number().int().optional(),
        }
      : {}),
  });

/**
 * Purchase orders: what was ordered, what was received, and, for the owner and support, the supplier invoices and their
 * three-way match state and the amounts (AC-ASSIST-23). The plant gets quantities and no match state. Without a code, the most
 * recent live orders.
 */
export const purchaseStatus: AssistantTool = {
  name: 'purchase_status',
  kind: 'read',
  description:
    'Purchase orders: supplier code, ordered and received quantities per line, status (expected, partial, complete) and, for the owner, the supplier invoice match state (gaps found or clean) and amounts. Optionally one order code (ACH-YYYY-NNNNN); otherwise the latest orders.',
  params: z.object({ po_code: PO_CODE.optional() }).strict(),
  roles: ['owner', 'plant', 'support'],
  permissions: ['purchases.read'],
  output: (role) =>
    z.object({ count: z.number().int(), purchases: z.array(purchase(can(role, 'purchases.read_money'))) }),
  async run(ctx, args) {
    const { po_code: wanted } = args as { po_code?: string };
    const money = can(ctx.actor.role, 'purchases.read_money');
    const receivable = (await listReceivable(ctx.appPool, ctx.actor))
      .filter((p) => (wanted ? p.code === wanted : !p.cancelled))
      .slice(0, wanted ? 1 : 10);
    const priced = money
      ? new Map((await listPurchases(ctx.appPool, ctx.actor)).map((p) => [p.code, p]))
      : null;
    const invoices = money ? await listSupplierInvoices(ctx.appPool, ctx.actor) : [];
    const purchases = [];
    for (const p of receivable) {
      const base = {
        code: p.code,
        supplier: p.supplierCode,
        orderDate: p.orderDate,
        status: p.status,
        cancelled: p.cancelled,
        lines: p.lines.slice(0, 20).map((l) => ({
          name: l.nameFr,
          unit: l.unitLabel,
          orderedQty: milli(l.qtyMilli),
          receivedQty: milli(l.receivedMilli),
        })),
      };
      if (!money) {
        purchases.push(base);
        continue;
      }
      const mine = invoices.filter((i) => i.purchaseCode === p.code).slice(0, 5);
      const matched = [];
      for (const i of mine) {
        const lines = (await getSupplierInvoiceMatch(ctx.appPool, ctx.actor, i.id)) ?? [];
        matched.push({
          code: i.code,
          state: i.state,
          gapLines: lines.filter((l) => l.flags.length > 0).length,
          flags: [...new Set(lines.flatMap((l) => l.flags))],
          totalCentimes: i.totalTtcCentimes,
        });
      }
      const view = priced?.get(p.code);
      purchases.push({
        ...base,
        invoices: matched,
        ...(view ? { totalCentimes: view.totalTtcCentimes, paidCentimes: view.paidCentimes } : {}),
      });
    }
    return { count: purchases.length, purchases };
  },
};
