import { createHash } from 'node:crypto';
import { getPool } from '@/lib/db/pools';
import { allowRead } from '@/lib/read-limit';
import { defaultFieldCipher } from '@/modules/master-data';
import { getDriverDay, getPumpDay } from '@/modules/field';
import { getRequestClock } from '@/app/request-clock';
import { getTimingBoard, type TripAlert } from '@/modules/operations';
import type { TripTimingView } from '@/modules/field/domain/timing-view';
import { fieldJson, fieldRoute } from '../context';

/** The driver's own timing: the plan, the delay so far, the projected return and the state of each rotation. A failure here never hides the day. */
async function timingOf(
  user: Parameters<typeof getTimingBoard>[1],
  date: string,
): Promise<Record<string, TripTimingView>> {
  try {
    const nowMs = (await getRequestClock()).now().getTime();
    const board = await getTimingBoard(getPool('app'), user, date, nowMs);
    const out: Record<string, TripTimingView> = {};
    for (const truck of board.trucks)
      for (const t of truck.trips) {
        const dayStart = t.trip.dayStartMs;
        const alert: TripAlert = t.alert;
        out[t.trip.tripId] = {
          plan: t.trip.plan,
          projectedBackMin: Math.round((t.projection.projectedBackMs - dayStart) / 60_000),
          cumulativeDelayMin: t.cumulativeDelayMin,
          alert: {
            level: alert.level,
            slipMin: alert.slipMin,
            nextOrderCode: alert.nextOrderCode,
            cause: alert.cause,
            overMin: alert.overMin,
          },
        };
      }
    return out;
  } catch {
    return {};
  }
}

/**
 * The answer with a strong-enough ETag over its content (T9): a phone that polls sends it back in If-None-Match and gets a 304 with no body
 * while nothing changed, so a 12-second refresh costs almost nothing. The tag says nothing a body would not: it is a hash of the content.
 */
function withEtag(request: Request, payload: unknown): Response {
  const text = JSON.stringify(payload);
  const etag = `W/"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;
  const headers = { 'cache-control': 'private, no-store', etag };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(text, { status: 200, headers: { ...headers, 'content-type': 'application/json' } });
}

// @permission driver or pump_operator session: the day of the signed-in driver (own rotations only, never a price)
export async function GET(request: Request): Promise<Response> {
  return fieldRoute(request, { write: false, session: true }, async ({ user, today }) => {
    if (!user) return fieldJson(401, { error: 'UNAUTHENTICATED' });
    if (!allowRead(`field-session:${user.id}`, (await getRequestClock()).now().getTime()))
      return fieldJson(429, { error: 'TOO_MANY' }, { 'retry-after': '30' });
    const cipher = defaultFieldCipher();
    const url = new URL(request.url);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') ?? '')
      ? (url.searchParams.get('date') as string)
      : today;
    if (user.role === 'pump_operator') {
      return withEtag(request, {
        kind: 'pump_operator',
        userId: user.id,
        date,
        jobs: await getPumpDay(getPool('app'), user, date, cipher),
      });
    }
    return withEtag(request, {
      kind: 'driver',
      userId: user.id,
      date,
      ...(await getDriverDay(getPool('app'), user, date, cipher)),
      timing: await timingOf(user, date),
    });
  });
}
