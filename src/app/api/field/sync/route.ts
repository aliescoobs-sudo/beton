import { getPool } from '@/lib/db/pools';
import { syncActions } from '@/modules/field';
import { fieldJson, fieldRoute } from '../context';

// @permission driver or pump_operator session: applies the phone's queued taps (idempotent on each tap's key)
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: true }, async ({ user }) => {
    if (!user) return fieldJson(401, { error: 'UNAUTHENTICATED' });
    const body = (await request.json().catch(() => null)) as { actions?: unknown } | null;
    const result = await syncActions(getPool('app'), user, body?.actions);
    return result.ok ? fieldJson(200, { outcomes: result.value }) : fieldJson(400, { error: result.error });
  });
}
