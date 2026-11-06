// What the phone shows about the timing of a rotation (T5 phase 2): the plan's times, the delay so far, and the state. A leaf with no
// import, so the client component can use it. Nothing here is a price; it is the driver's own data.

export const DELAY_REASONS = ['traffic', 'site_wait', 'breakdown', 'other'] as const;
export type DelayReason = (typeof DELAY_REASONS)[number];

export interface TripTimingView {
  /** The plan's milestones, minutes from midnight (they may pass 1440). */
  plan: { loadMin: number; departMin: number; arriveMin: number; unloadEndMin: number; backMin: number };
  /** The projected return, minutes from midnight of the trip's day. */
  projectedBackMin: number;
  /** The last tap against the plan, in minutes (negative: early); null before any tap. */
  cumulativeDelayMin: number | null;
  alert: {
    level: 'none' | 'watch' | 'critical';
    slipMin: number;
    nextOrderCode: string | null;
    cause: 'next_trip_delayed' | 'stage_over_estimate' | 'late_start' | null;
    overMin: number;
  };
}

/** 530 -> "08:50"; 1500 -> "01:00" (the next day). */
export const clockOfMinutes = (min: number): string => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** "+20", "-5", "0": the sign is part of the figure. */
export const signedMinutes = (min: number): string => (min > 0 ? `+${min}` : String(min));
