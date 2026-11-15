'use server';

import { revalidatePath } from 'next/cache';
import { getPool } from '@/lib/db/pools';
import {
  replaceCostRate,
  replaceFuelNorm,
  replacePriceGrid,
  replacePurchaseTransport,
} from '@/modules/master-data';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Answer = { ok: true } | { ok: false; error: string };
const deps = () => ({ getState: currentAuthState, appPool: getPool('app') });

async function act(
  run: (user: Parameters<typeof replaceCostRate>[1]) => Promise<{ ok: boolean; error?: string }>,
): Promise<Answer> {
  const allowed = await authorize('costs.manage', deps());
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const r = await run(allowed.user);
    if (r.ok) revalidatePath('/costs');
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'INVALID' };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission costs.manage (owner, app_admin): a new versioned cost rate (a replacement of an assumed value is a new row, never an update)
export async function replaceCostRateAction(input: unknown): Promise<Answer> {
  return act((u) => replaceCostRate(getPool('app'), u, input));
}

// @permission costs.manage (owner, app_admin): a new versioned fuel norm
export async function replaceFuelNormAction(input: unknown): Promise<Answer> {
  return act((u) => replaceFuelNorm(getPool('app'), u, input));
}

// @permission costs.manage (owner, app_admin): the transport that makes a purchase price a delivered price
export async function replacePurchaseTransportAction(input: unknown): Promise<Answer> {
  return act((u) => replacePurchaseTransport(getPool('app'), u, input));
}

// @permission costs.manage (owner, app_admin): a new versioned selling price of a class and a discharge method
export async function replacePriceGridAction(input: unknown): Promise<Answer> {
  return act((u) => replacePriceGrid(getPool('app'), u, input));
}
