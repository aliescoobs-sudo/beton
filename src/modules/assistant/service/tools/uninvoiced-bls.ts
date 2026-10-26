import { z } from 'zod';
import { getInvoiceQueue } from '@/modules/ledger';
import { can } from '@/modules/platform-security';
import type { AssistantTool } from '../../domain/tool-types';
import { litresToM3 } from '../../domain/units';
import { CLIENT_CODE } from './shared';

const bl = (money: boolean) =>
  z.object({
    bl: z.string(),
    loadDate: z.string(),
    deliveredDate: z.string(),
    m3: z.number(),
    product: z.string(),
    ...(money ? { amountHtCentimes: z.number().int().optional() } : {}),
  });
const client = (money: boolean) =>
  z.object({
    client: z.string().nullable(),
    blCount: z.number().int(),
    totalM3: z.number(),
    bls: z.array(bl(money)),
    ...(money
      ? {
          htCentimes: z.number().int().optional(),
          vatCentimes: z.number().int().optional(),
          ttcCentimes: z.number().int().optional(),
        }
      : {}),
  });

/**
 * The delivered loads no invoice carries yet, per client (the invoicing queue). BL number, date, m³ and product; the amounts only
 * for the owner and support: office's output has no money key at all, not even an empty one.
 */
export const uninvoicedBls: AssistantTool = {
  name: 'uninvoiced_bls',
  kind: 'read',
  description:
    'Delivered BLs that are not invoiced yet, per client: BL number, load date, delivery date, volume in m³ and product. Optionally for one client code. Use it to know what can be invoiced.',
  params: z.object({ client: CLIENT_CODE.optional() }).strict(),
  roles: ['owner', 'office', 'support'],
  permissions: ['invoices.queue'],
  output: (role) => {
    const money = can(role, 'invoices.read');
    return z.object({ count: z.number().int(), clients: z.array(client(money)) });
  },
  async run(ctx, args) {
    const { client: wanted } = args as { client?: string };
    const withMoney = can(ctx.actor.role, 'invoices.read');
    const queue = await getInvoiceQueue(ctx.appPool, ctx.actor);
    const clients = queue
      .map((c) => ({ c, code: ctx.codeOfName(c.clientName) ?? c.clientCode }))
      .filter(({ code }) => (wanted ? code === wanted : true))
      .map(({ c, code }) => ({
        client: code,
        blCount: c.deliveries.length,
        totalM3: litresToM3(c.totalVolumeL),
        bls: c.deliveries.slice(0, 20).map((d) => ({
          bl: d.blNo,
          loadDate: d.loadDate,
          deliveredDate: d.deliveredAt.slice(0, 10),
          m3: litresToM3(d.volumeL),
          product: d.typeLabel,
          ...(withMoney && d.amountHtCentimes !== undefined ? { amountHtCentimes: d.amountHtCentimes } : {}),
        })),
        ...(withMoney && c.money
          ? {
              htCentimes: c.money.htCentimes,
              vatCentimes: c.money.vatCentimes,
              ttcCentimes: c.money.ttcCentimes,
            }
          : {}),
      }));
    return { count: clients.length, clients: clients.slice(0, 20) };
  },
};
