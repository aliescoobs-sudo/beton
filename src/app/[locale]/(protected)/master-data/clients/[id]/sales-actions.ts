'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { addClientAlias, setClientTerms } from '@/modules/ledger';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Answer = { ok: boolean; error?: string };

// @permission parties.write (owner, app_admin, partner, office, office_sales, office_purchases): another name of the same client (the doors check the role again)
export async function addAliasAction(input: unknown): Promise<Answer> {
  const allowed = await authorize('parties.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const r = await addClientAlias(getPool('app'), allowed.user, input);
  if (r.ok) revalidatePath('/[locale]/master-data/clients/[id]', 'page');
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// @permission client_terms.write (owner, app_admin, office_sales): the client's PO number is mandatory on its orders; HT or TTC basis
export async function setTermsAction(input: unknown): Promise<Answer> {
  const allowed = await authorize('client_terms.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const r = await setClientTerms(getPool('app'), allowed.user, input);
  if (r.ok) revalidatePath('/[locale]/master-data/clients/[id]', 'page');
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
