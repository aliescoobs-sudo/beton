import type pg from 'pg';
import { buildForecast, type Forecast, type ForecastItem } from '../domain/cash-forecast';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';
import { listOpeningObligations } from './opening-detail-service';

/**
 * The cash forecast of the next 30 / 60 / 90 days (T19c B3, D245): the client cheques and LCN not cleared yet, the cheques and LCN we issued not cleared yet,
 * and the loan and leasing instalments of the opening obligations schedule. Each role reads its own side (the rows come through row-level security, the same
 * side split as the statements): the Responsable the client cheques, the Assistante the issued cheques, owner and app_admin both and the instalments, and
 * only they get the net line. The instalments hold a lender and a reference: they are not shown to the office roles. Arithmetic is in the domain.
 */
export interface ForecastView extends Forecast {
  sides: { client: boolean; supplier: boolean; instalments: boolean; net: boolean };
}

export async function getCashForecast(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string },
): Promise<ForecastView> {
  const client = can(actor.role, 'forecast.client');
  const supplier = can(actor.role, 'forecast.supplier');
  if (!client && !supplier) await require(appPool, actor, 'forecast.client');
  const items: ForecastItem[] = [];
  const rows = await inRequest(appPool, actor, async (tx) => {
    const out: ForecastItem[] = [];
    for (const [side, allowed] of [
      ['in', client],
      ['out', supplier],
    ] as const) {
      if (!allowed) continue;
      const r = await tx.query<{
        number: string | null;
        method: string;
        amount: string;
        due: string;
        party: string | null;
      }>(
        `select i.number, i.method, i.amount_centimes::text as amount,
                to_char(coalesce(i.due_date, i.written_date, i.received_date), 'YYYY-MM-DD') as due, coalesce(c.name, s.name) as party
           from payment_instrument i
           cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
           left join client c on c.id = i.client_id
           left join supplier s on s.id = i.supplier_id
          where i.direction = $1 and i.method in ('cheque', 'lcn') and last.event in ('received', 'deposited', 'issued')
            and coalesce(i.due_date, i.written_date, i.received_date) is not null`,
        [side],
      );
      for (const x of r.rows)
        out.push({
          kind: side === 'in' ? 'client_cheque' : 'issued_cheque',
          side,
          label: `${x.method === 'lcn' ? 'LCN' : 'CHQ'} ${x.number ?? ''}`.trim(),
          party: x.party,
          dueDate: x.due,
          amountCentimes: Number(x.amount),
        });
    }
    return out;
  });
  items.push(...rows);
  const instalments = can(actor.role, 'opening.write');
  if (instalments)
    for (const o of await listOpeningObligations(appPool, actor))
      for (const i of o.instalments)
        items.push({
          kind: 'instalment',
          side: 'out',
          label: o.reference,
          party: o.lender,
          dueDate: i.dueDate,
          amountCentimes: i.amountCentimes,
        });
  // an instalment due before today has no "paid" mark in the schedule: it is not an overdue cheque, it is left out rather than shown as unpaid
  const kept = items.filter((i) => i.kind !== 'instalment' || i.dueDate >= deps.today);
  return {
    ...buildForecast(kept, deps.today),
    sides: { client, supplier, instalments, net: client && supplier },
  };
}
