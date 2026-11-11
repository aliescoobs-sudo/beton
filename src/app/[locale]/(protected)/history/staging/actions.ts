'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import { decideLabel, decideQuarantine, type LabelKind } from '@/modules/importer';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

const KINDS: readonly LabelKind[] = ['client', 'truck', 'driver', 'type', 'pump', 'category'];

async function owner() {
  const allowed = await authorize('history.admin', { getState: currentAuthState, appPool: getPool('app') });
  return allowed.ok ? allowed.user : null;
}

/**
 * One decision on one label, from a form: `choice` is "map:<id or code>", "new", "label_only" or "unknown".
 * @permission history.admin (owner, app_admin)
 */
export async function decideLabelAction(formData: FormData): Promise<void> {
  const user = await owner();
  if (!user) return;
  const kind = String(formData.get('kind') ?? '') as LabelKind;
  const key = String(formData.get('key') ?? '');
  const choice = String(formData.get('choice') ?? '');
  if (!KINDS.includes(kind) || !key || !choice) return;
  const target = choice.startsWith('map:') ? choice.slice(4) : '';
  let input: Record<string, unknown> | null = null;
  if (choice === 'new' || choice === 'label_only' || choice === 'unknown')
    input = { kind, key, status: choice };
  else if (target) {
    const field = {
      client: 'clientId',
      truck: 'truckId',
      driver: 'driverId',
      type: 'canonical',
      pump: 'canonical',
      category: 'canonical',
    }[kind];
    input = { kind, key, status: 'mapped', [field]: target };
  }
  if (input) await decideLabel(getPool('app'), user, input);
  revalidatePath('/[locale]/history/staging', 'page');
}

/**
 * Fix or discard one quarantined row.
 * @permission history.admin (owner, app_admin)
 */
export async function decideQuarantineAction(formData: FormData): Promise<void> {
  const user = await owner();
  if (!user) return;
  const id = String(formData.get('id') ?? '');
  const action = String(formData.get('action') ?? '');
  const values: Record<string, string> = {};
  for (const f of ['date', 'm3', 'amount', 'label']) {
    const v = String(formData.get(`v_${f}`) ?? '').trim();
    if (v) values[f] = v;
  }
  if (action === 'discard') await decideQuarantine(getPool('app'), user, { id, action: 'discard' });
  else if (action === 'fix') await decideQuarantine(getPool('app'), user, { id, action: 'fix', values });
  revalidatePath('/[locale]/history/staging', 'page');
}
