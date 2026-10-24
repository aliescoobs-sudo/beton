/**
 * R4 (AC-OPS-08): concrete must be unloaded within its workable time. The one-way trip of the zone plus the unloading
 * on site against the limit: exactly the limit is fine (60 + 30 = 90 with a limit of 90 gives no warning).
 */
export const tripExceedsLimit = (oneWayMin: number, unloadingMin: number, limitMin: number): boolean =>
  oneWayMin + unloadingMin > limitMin;
