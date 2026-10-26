import type pg from 'pg';
import { parameterOrDefault } from '@/modules/platform-security';

export type OpsParameterKey =
  | 'concrete_limit_min'
  | 'unloading_min'
  | 'load_excess_tolerance_bp'
  | 'loading_min'
  | 'return_extra_min'
  | 'working_min'
  | 'day_start_min'
  | 'default_one_way_min'
  | 'consumption_tolerance_bp'
  | 'reorder_margin_days'
  | 'upload_max_bytes';

/** An operations parameter as the roles that load, plan and read trucks may read it (the plant cannot read the parameter table). */
export async function opsParameter(tx: pg.PoolClient, key: OpsParameterKey): Promise<number> {
  const { rows } = await tx.query<{ value: unknown }>('select public.ops_parameter($1) as value', [key]);
  return parameterOrDefault(key, rows[0]?.value);
}
