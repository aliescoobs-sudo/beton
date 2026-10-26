import { z } from 'zod';
import { centimes, subCentimes, sumCentimes } from '@/lib/money';
import { listOpenInvoices } from '@/modules/ledger';
import type { AssistantTool } from '../../domain/tool-types';
import { daysBetweenIso } from '../../domain/units';
import { CLIENT_CODE } from './shared';

const invoice = z.object({
  number: z.string(),
  client: z.string().nullable(),
  dueDate: z.string(),
  overdue: z.boolean(),
  daysOverdue: z.number().int(),
  totalCentimes: z.number().int(),
  paidCentimes: z.number().int(),
  openCentimes: z.number().int(),
});
const out = z.object({
  count: z.number().int(),
  openTotalCentimes: z.number().int(),
  invoices: z.array(invoice),
});

/** The invoices not fully paid, oldest due date first, with what is paid and what remains. Owner and support only. */
export const openInvoices: AssistantTool = {
  name: 'open_invoices',
  kind: 'read',
  description:
    'Open (unpaid or partly paid) invoices, oldest due date first: number, client code, due date, whether overdue, total, paid and remaining. Optionally for one client code. Amounts are placeholders to quote as written.',
  params: z.object({ client: CLIENT_CODE.optional() }).strict(),
  roles: ['owner', 'support'],
  permissions: ['invoices.read'],
  output: () => out,
  async run(ctx, args) {
    const { client: wanted } = args as { client?: string };
    const open = await listOpenInvoices(ctx.appPool, ctx.actor);
    const rows = open
      .map((i) => ({ i, code: ctx.codeOfName(i.clientName) }))
      .filter(({ code }) => (wanted ? code === wanted : true));
    const invoices = rows.slice(0, 30).map(({ i, code }) => {
      const days = daysBetweenIso(i.dueDate, ctx.today);
      return {
        number: i.number,
        client: code,
        dueDate: i.dueDate,
        overdue: days > 0,
        daysOverdue: Math.max(0, days),
        totalCentimes: i.totalTtcCentimes,
        paidCentimes: subCentimes(centimes(i.totalTtcCentimes), centimes(i.openCentimes)),
        openCentimes: i.openCentimes,
      };
    });
    return {
      count: rows.length,
      openTotalCentimes: sumCentimes(rows.map(({ i }) => centimes(i.openCentimes))),
      invoices,
    };
  },
};
