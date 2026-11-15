import type pg from 'pg';
import { type AgingRow, addAging, ageEntries, emptyAging, type OpenEntry } from '../domain/opening-items';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';
import { loadParties, type PartyKind } from './statement-service';

/**
 * The aging of what clients owe us and what we owe suppliers (T19c B2, D245): buckets current, 1-30, 31-60, 61-90 and 90+ days past due, per party, with the total.
 * Entries are the open plan items (due date and what is still uncovered), the per-invoice opening items after the unallocated credit, and, for a party with no
 * per-invoice detail (or a part of its opening line the items do not cover), one "no due date known" amount. Each role reads the side its statements
 * permission allows; the database refuses the other side's rows anyway. A plant filter keeps the orders and purchases of that plant; the opening position has no plant
 * and is left out of a filtered view (the screen says so).
 */
export interface AgingParty {
  partyId: string;
  kind: PartyKind;
  code: string;
  name: string;
  aging: AgingRow;
}
export interface AgingReport {
  kind: PartyKind;
  today: string;
  plantId: string | null;
  parties: AgingParty[];
  total: AgingRow;
}

const permission = (kind: PartyKind) => (kind === 'client' ? 'aging.client' : 'aging.supplier');

/** The sides this actor may read, in a fixed order. */
export const agingSides = (actor: SessionUser): PartyKind[] =>
  (['client', 'supplier'] as const).filter((k) => can(actor.role, permission(k)));

export async function getAging(
  appPool: pg.Pool,
  actor: SessionUser,
  kind: PartyKind,
  deps: { today: string; plantId?: string | null },
): Promise<AgingReport> {
  await require(appPool, actor, permission(kind));
  const plantId = deps.plantId ?? null;
  return inRequest(appPool, actor, async (tx) => {
    const parties = await tx.query<{ id: string; code: string; name: string }>(
      `select id, code, name from ${kind} where status = 'active' order by lower(name)`,
    );
    const data = await loadParties(
      tx,
      kind,
      parties.rows.map((p) => p.id),
    );
    const out: AgingParty[] = [];
    let total = emptyAging();
    for (const p of parties.rows) {
      const d = data.get(p.id);
      if (!d) continue;
      const entries: OpenEntry[] = d.due
        .filter((i) => i.plantId !== undefined) // plan items only (opening entries are in d.opening)
        .filter((i) => plantId === null || i.plantId === plantId)
        .map((i) => ({
          dueDate: i.dueDate,
          openCentimes: Math.max(0, Number(i.amountCentimes) - Number(i.coveredCentimes)),
          origin: 'plan_item' as const,
        }));
      if (plantId === null) entries.push(...d.opening);
      const aging = ageEntries(entries, deps.today);
      if (aging.total === 0) continue;
      out.push({ partyId: p.id, kind, code: p.code, name: p.name, aging });
      total = addAging(total, aging);
    }
    return { kind, today: deps.today, plantId, parties: out, total };
  });
}

/** The CSV (the export pattern of the charges register): amounts in MAD with a decimal comma, one line per party and a total line. */
export function agingToCsv(report: AgingReport): string {
  const mad = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const cell = (v: string) => `"${v.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const head = ['code', 'name', 'current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'no_due_date', 'total'];
  const line = (code: string, name: string, a: AgingRow) =>
    [
      code,
      name,
      mad(a.current),
      mad(a.d1_30),
      mad(a.d31_60),
      mad(a.d61_90),
      mad(a.d90plus),
      mad(a.unknown),
      mad(a.total),
    ].join(';');
  return [
    head.join(';'),
    ...report.parties.map((p) => line(cell(p.code), cell(p.name), p.aging)),
    line('TOTAL', '', report.total),
  ].join('\n');
}
