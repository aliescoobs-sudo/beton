'use server';

import { getPool } from '@/lib/db/pools';
import { getInvoiceDocument } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission invoices.read (owner, support): the print of an invoice is audited as an export (DECISIONS 82)
export async function printInvoiceAction(invoiceId: string): Promise<{ ok: boolean }> {
  const allowed = await authorize('invoices.read', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false };
  const doc = await getInvoiceDocument(getPool('app'), allowed.user, invoiceId);
  if (!doc) return { ok: false };
  await recordMoneyExport(getPool('app'), allowed.user, `print:invoice:${doc.invoice.number}`);
  return { ok: true };
}
