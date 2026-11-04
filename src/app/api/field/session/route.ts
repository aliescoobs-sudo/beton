import { getPool } from '@/lib/db/pools';
import { defaultFieldCipher } from '@/modules/master-data';
import { getDriverDay, getPumpDay } from '@/modules/field';
import { fieldJson, fieldRoute } from '../context';

// @permission driver or pump_operator session: the day of the signed-in driver (own rotations only, never a price)
export async function GET(request: Request): Promise<Response> {
  return fieldRoute(request, { write: false, session: true }, async ({ user, today }) => {
    if (!user) return fieldJson(401, { error: 'UNAUTHENTICATED' });
    const cipher = defaultFieldCipher();
    const url = new URL(request.url);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') ?? '')
      ? (url.searchParams.get('date') as string)
      : today;
    if (user.role === 'pump_operator') {
      return fieldJson(200, {
        kind: 'pump_operator',
        userId: user.id,
        date,
        jobs: await getPumpDay(getPool('app'), user, date, cipher),
      });
    }
    return fieldJson(200, {
      kind: 'driver',
      userId: user.id,
      date,
      ...(await getDriverDay(getPool('app'), user, date, cipher)),
    });
  });
}
