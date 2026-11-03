/**
 * R10 (REQUIREMENTS-V1 §11): what the anomaly report says about each count. The database counts recorded facts; these thresholds are the
 * deterministic rule that turns a count into "look at this". No model is involved and no amount appears.
 */
export const ANOMALY_KINDS = [
  'job_failed',
  'stuck_trip',
  'late_cancellation',
  'stock_variance',
  'late_confirmation',
  'bl_not_returned',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

/** From this many in the window a kind is flagged. 1 for what should never happen, higher for what happens sometimes. */
export const ANOMALY_THRESHOLD: Record<AnomalyKind, number> = {
  job_failed: 1,
  stuck_trip: 1,
  late_cancellation: 3,
  stock_variance: 3,
  late_confirmation: 1,
  bl_not_returned: 3,
};

export interface AnomalyRow {
  kind: AnomalyKind;
  n: number;
  refs: string[];
  flagged: boolean;
}

export function flagAnomaly(kind: AnomalyKind, n: number): boolean {
  return n >= ANOMALY_THRESHOLD[kind];
}
