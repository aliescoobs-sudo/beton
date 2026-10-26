import { z } from 'zod';
import { getOrderChain } from '@/modules/ledger';
import { can } from '@/modules/platform-security';
import type { AssistantTool } from '../../domain/tool-types';
import { litresToM3 } from '../../domain/units';

const ORDER_CODE = z.string().regex(/^CMD-\d{4}-\d{5,}$/, 'an order code like CMD-2026-00012');

const stages = (money: boolean) =>
  z.object({
    orderedM3: z.number(),
    plannedM3: z.number(),
    loadedM3: z.number(),
    deliveredM3: z.number(),
    invoicedM3: z.number(),
    // The paid stage exists for the roles with money only: for the others there is no key, not even a null.
    ...(money ? { paid: z.enum(['unpaid', 'partial', 'paid']).nullable() } : {}),
  });

/**
 * The six stages of one order: ordered, planned, loaded, delivered, invoiced, paid (AC-ASSIST-21). Quantities in m³ for the five
 * first; the paid stage is the payment state of the order, given to the owner and support only and absent for the others.
 */
export const orderChain: AssistantTool = {
  name: 'order_chain',
  kind: 'read',
  description:
    'Where one order stands: ordered, planned, loaded, delivered and invoiced volumes in m³, and for the roles with money whether it is paid. Needs the order code (CMD-YYYY-NNNNN).',
  params: z.object({ order_code: ORDER_CODE }).strict(),
  roles: ['owner', 'partner', 'office', 'plant', 'support'],
  permissions: ['orders.chain'],
  output: (role) =>
    z.object({
      found: z.boolean(),
      order: z
        .object({
          code: z.string(),
          client: z.string(),
          product: z.string(),
          orderDate: z.string(),
          deliveryDate: z.string(),
          cancelled: z.boolean(),
          stages: stages(can(role, 'orders.read_money')),
        })
        .nullable(),
    }),
  async run(ctx, args) {
    const { order_code: code } = args as { order_code: string };
    const money = can(ctx.actor.role, 'orders.read_money');
    const row = (await getOrderChain(ctx.appPool, ctx.actor)).find((r) => r.code === code);
    if (!row) return { found: false, order: null };
    return {
      found: true,
      order: {
        code: row.code,
        client: row.clientCode,
        product: row.typeCode,
        orderDate: row.orderDate,
        deliveryDate: row.deliveryDate,
        cancelled: row.cancelled,
        stages: {
          orderedM3: litresToM3(row.orderedL),
          plannedM3: litresToM3(row.plannedL),
          loadedM3: litresToM3(row.loadedL),
          deliveredM3: litresToM3(row.deliveredL),
          invoicedM3: litresToM3(row.invoicedL),
          ...(money ? { paid: row.paidState } : {}),
        },
      },
    };
  },
};
