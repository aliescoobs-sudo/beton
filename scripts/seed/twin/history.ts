// T20 item 2 (injected defects): the plants' paper BL books for the sales period, written as an applied batch of the history layer (the flagged layer of D210-D214).
// The live `delivery` table has ONE gapless numbering and a unique BL number, so duplicates cannot exist there; the paper books of the plants can have them, and this
// is where the importer's reports find them. Each plant has its own running number (Tétouan from 4100, Chefchaouen from 2300). Defects, on purpose:
//   - about 12 numbers a month missing per plant (the number jumps by 2);
//   - 4 duplicated BL numbers (a row repeats the number of the one before it): 2 per plant;
//   - one date typed as text in the sheet (the row says so in its legacy cell and its note).
// Written by the owner through the history tables' own policies (the batch moves staged -> applied, forward only). The history importer is NOT run: it is switched off on
// staging (STAGING_PROFILE, D226) and the seed does not go round that.
import { createHash, randomUUID } from 'node:crypto';
import { inRequest } from '../../../src/modules/platform-security/index.ts';
import type { TwinContext } from './context.ts';
import type { World } from './structure.ts';

export interface HistoryRow {
  plant: 'TET' | 'CHF';
  date: string;
  month: string;
  volumeL: number;
  clientIdx: number;
  typeCode: string;
  method: 'GOULOTTE' | 'POMPE';
  truckCode: string;
  blNo: number;
  textDate: boolean;
}
export interface HistoryResult {
  rows: number;
  duplicates: number;
  gaps: number;
  textDates: number;
}

/** The spellings an office writes by hand for one client (case, a trailing digit, a double space): picked by position, so the result never changes. */
export const spelling = (name: string, k: number): string => {
  const base = name.replace(/ \(fictif\)$/i, '');
  const v = [base, base.toUpperCase(), base.toLowerCase(), `${base} 1`, base.replace(' ', '  ')];
  return `${v[k % v.length]} FICTIF`;
};

/** Pure: the paper rows and their numbering, from the loads in business-date order. */
export function numberPaperBooks(
  loads: readonly Omit<HistoryRow, 'blNo' | 'textDate' | 'month'>[],
  rng: { next: () => number; int: (a: number, b: number) => number },
  anchor: string,
): HistoryRow[] {
  const out: HistoryRow[] = [];
  const next: Record<'TET' | 'CHF', number> = { TET: 4100, CHF: 2300 };
  const monthRows = new Map<string, number>();
  for (const l of loads) {
    const month = l.date.slice(0, 7);
    const key = `${l.plant}|${month}`;
    monthRows.set(key, (monthRows.get(key) ?? 0) + 1);
  }
  // A row loses its number (the next one jumps by 2) when it is one of the first `quota` picks of its plant-month.
  const skip = new Set<string>();
  for (const [key, n] of monthRows) {
    const month = key.split('|')[1]!;
    const quota = month === anchor.slice(0, 7) ? Math.round((12 * Number(anchor.slice(8))) / 30) : 12;
    const picked = new Set<number>();
    while (picked.size < Math.min(quota, Math.floor(n / 3))) picked.add(rng.int(2, Math.max(2, n - 1)));
    for (const i of picked) skip.add(`${key}|${i}`);
  }
  const seen = new Map<string, number>();
  const dupAt = new Set<number>();
  while (dupAt.size < 4) dupAt.add(rng.int(20, Math.max(21, loads.length - 5)));
  let dupCount = 0;
  let textRow = -1;
  for (const [pos, l] of loads.entries()) {
    const key = `${l.plant}|${l.date.slice(0, 7)}`;
    const idx = (seen.get(key) ?? 0) + 1;
    seen.set(key, idx);
    const previous = out.filter((r) => r.plant === l.plant).at(-1);
    let blNo: number;
    if (dupAt.has(pos) && previous && dupCount < 4) {
      blNo = previous.blNo; // the same number written twice
      dupCount += 1;
    } else {
      next[l.plant] += skip.has(`${key}|${idx}`) ? 2 : 1;
      blNo = next[l.plant];
    }
    if (textRow < 0 && l.date >= '2026-10-03' && rng.next() < 0.02) textRow = pos;
    out.push({ ...l, month: l.date.slice(0, 7), blNo, textDate: pos === textRow });
  }
  if (textRow < 0 && out.length > 50) out[50]!.textDate = true;
  return out;
}

export async function buildHistory(ctx: TwinContext, world: World): Promise<HistoryResult> {
  const { app } = ctx.pools;
  const { owner, anchor } = ctx;
  const loads = (
    await ctx.pools.migrator.query<{
      plant: string;
      date: string;
      volume_l: number;
      client_id: string;
      type: string;
      method: string;
      truck: string;
    }>(
      `select p.code as plant, to_char(d.load_date, 'YYYY-MM-DD') as date, d.volume_l, o.client_id, t.code as type, coalesce(o.discharge_method, 'GOULOTTE') as method, k.code as truck
         from delivery d join sales_order o on o.id = d.order_id join plant p on p.id = o.plant_id
         join concrete_type t on t.id = o.concrete_type_id join truck k on k.id = d.truck_id
        where d.reverses_id is null and d.load_date <= $1 order by d.load_date, d.loaded_at, d.bl_no`,
      [anchor],
    )
  ).rows.map((r) => ({
    plant: (r.plant === 'TETOUAN' ? 'TET' : 'CHF') as 'TET' | 'CHF',
    date: r.date,
    volumeL: r.volume_l,
    clientIdx: world.clients.findIndex((c) => c.id === r.client_id),
    typeCode: r.type,
    method: r.method as 'GOULOTTE' | 'POMPE',
    truckCode: r.truck,
  }));
  const rows = numberPaperBooks(loads, ctx.rng, anchor);
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const sha = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  let duplicates = 0;
  let gaps = 0;
  let textDates = 0;
  for (const plant of ['TET', 'CHF'] as const) {
    const mine = rows.filter((r) => r.plant === plant);
    const stats: Record<
      string,
      { rows: number; litres: number; qRows: number; qLitres: number; cents: number }
    > = {};
    for (const r of mine) {
      const s = (stats[r.month] ??= { rows: 0, litres: 0, qRows: 0, qLitres: 0, cents: 0 });
      s.rows += 1;
      s.litres += r.volumeL;
    }
    mine.forEach((r, i) => {
      const prev = mine[i - 1];
      if (prev && r.blNo === prev.blNo) duplicates += 1;
      if (prev && r.blNo - prev.blNo > 1) gaps += r.blNo - prev.blNo - 1;
      if (r.textDate) textDates += 1;
    });
    const batchId = randomUUID();
    await inRequest(app, owner, async (tx) => {
      await tx.query(
        `insert into history.batch (id, kind, plant_id, set_sha, files, read_stats, created_by) values ($1, 'deliveries', $2, $3, $4, $5, $6)`,
        [
          batchId,
          ctx.plants[plant].id,
          createHash('sha256').update(`${sha}|${plant}`).digest('hex'),
          months.length,
          JSON.stringify(stats),
          owner.id,
        ],
      );
      let row = 0;
      for (const r of mine) {
        row += 1;
        const client = world.clients[r.clientIdx]!;
        await tx.query(
          `insert into history.delivery (id, batch_id, plant_id, delivery_date, volume_l, client_raw, client_id, type_raw, type_code, pump_mode, truck_raw, bl_raw, note, legacy, src_file, src_sheet, src_row, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, $17)`,
          [
            randomUUID(),
            batchId,
            ctx.plants[plant].id,
            r.date,
            r.volumeL,
            spelling(client.spec.name, row),
            client.id,
            r.typeCode,
            r.typeCode,
            row % 19 === 0 ? 'unknown' : r.method === 'POMPE' ? 'pump' : 'chute', // the pump column is empty on about one row in twenty, as in the real files
            r.truckCode,
            String(r.blNo),
            r.textDate
              ? `date saisie en texte (${r.date.slice(8)}/${r.date.slice(5, 7)}/${r.date.slice(0, 4)})`
              : null,
            JSON.stringify(r.textDate ? { date_cell: 'text' } : {}),
            months.indexOf(r.month) + 1,
            row,
            owner.id,
          ],
        );
      }
      await tx.query(
        `update history.batch set status = 'applied', applied_by = $2, applied_at = clock_timestamp(), counts = $3 where id = $1`,
        [batchId, owner.id, JSON.stringify({ deliveries: mine.length })],
      );
    });
  }
  return { rows: rows.length, duplicates, gaps, textDates };
}
