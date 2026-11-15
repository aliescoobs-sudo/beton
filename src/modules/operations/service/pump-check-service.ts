import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * T17 G10 (D243): the pump check. One door (pump_check: owner, app_admin, and the plant manager of his own plant) lists, per day and plant, the three things that do not add up:
 * (a) a POMPE BL with no pump job, (b) a pump job with no POMPE BL, (c) a GOULOTTE BL on a day and plant where a pump job exists for the same client. Quantities and references only: no cost.
 */
export const PUMP_CHECK_KINDS = ['pompe_bl_no_job', 'job_no_pompe_bl', 'goulotte_bl_with_job'] as const;
export type PumpCheckKind = (typeof PUMP_CHECK_KINDS)[number];
export type PumpCheckError = 'INVALID';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const inputSchema = z.object({ from: day, to: day, plantId: z.string().uuid().nullable().default(null) });

export interface PumpCheckRow {
  kind: PumpCheckKind;
  day: string;
  plantId: string | null;
  plantCode: string | null;
  clientCode: string | null;
  clientName: string | null;
  blNo: string | null;
  jobId: string | null;
  siteLabel: string | null;
  volumeL: number | null;
}

export async function loadPumpCheck(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<PumpCheckRow[], PumpCheckError>> {
  await require(appPool, actor, 'pump_check.read');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  try {
    const rows = await inRequest(appPool, actor, (tx) =>
      tx.query<Record<string, string | null>>(
        `select o_kind, to_char(o_day, 'YYYY-MM-DD') d, o_plant_id, o_plant_code, o_client_code, o_client_name, o_bl_no, o_job_id, o_site_label, o_volume_l::text vol
           from public.pump_check($1, $2, $3)`,
        [v.from, v.to, v.plantId],
      ),
    );
    return ok(
      rows.rows.map((r) => ({
        kind: r.o_kind as PumpCheckKind,
        day: String(r.d),
        plantId: r.o_plant_id ?? null,
        plantCode: r.o_plant_code ?? null,
        clientCode: r.o_client_code ?? null,
        clientName: r.o_client_name ?? null,
        blNo: r.o_bl_no ?? null,
        jobId: r.o_job_id ?? null,
        siteLabel: r.o_site_label ?? null,
        volumeL: r.vol === null ? null : Number(r.vol),
      })),
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23514') return err('INVALID');
    throw error;
  }
}
