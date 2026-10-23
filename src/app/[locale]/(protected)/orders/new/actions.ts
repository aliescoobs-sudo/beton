'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  createOrder,
  type CreatedOrder,
  type OrderError,
  type OrderPreview,
  previewOrder,
} from '@/modules/ledger';
import { authorize, ForbiddenError, type Permission } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: OrderError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

async function guarded<T>(
  permission: Permission,
  run: (
    user: Parameters<typeof createOrder>[1],
    today: string,
  ) => Promise<{ ok: true; value: T } | { ok: false; error: OrderError }>,
): Promise<{ ok: true; value: T } | Failure> {
  const allowed = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    return await run(allowed.user, (await getRequestClock()).today());
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission orders.write (owner, office): blind entry, the result carries the code only
export async function createOrderAction(input: unknown): Promise<{ ok: true; code: string } | Failure> {
  const result = await guarded<CreatedOrder>('orders.write', (user, today) =>
    createOrder(getPool('app'), user, input, { today }),
  );
  return result.ok ? { ok: true, code: result.value.code } : result;
}

// @permission orders.read_money (owner)
export async function previewOrderAction(
  input: unknown,
): Promise<{ ok: true; preview: OrderPreview } | Failure> {
  const result = await guarded<OrderPreview>('orders.read_money', (user, today) =>
    previewOrder(getPool('app'), user, input, { today }),
  );
  return result.ok ? { ok: true, preview: result.value } : result;
}
