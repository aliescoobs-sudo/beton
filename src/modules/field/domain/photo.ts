/** What the phone does with a queued photo after the server answered (or did not). Pure, shared by the UI and its test. */
export type PhotoVerdict = 'sent' | 'retry' | 'drop';

/**
 * 200: stored (or already stored: a replay). 401: signed out, the photo stays until the next sign-in. 5xx, 408, 429 and a network
 * failure: try again later. Any other 4xx (not your rotation, not unloaded yet is retried, too many, too large, corrupt): sending it
 * again cannot change the answer, so it is dropped and the driver is told.
 */
export function photoVerdict(status: number | null, error?: string): PhotoVerdict {
  if (status === null) return 'retry';
  if (status === 200) return 'sent';
  if (status === 401 || status === 408 || status === 429 || status >= 500) return 'retry';
  // The unloading tap may not have reached the server yet (offline queue): the photo waits for it.
  if (error === 'NOT_UNLOADED') return 'retry';
  return 'drop';
}

/** Longest side of the photo sent from the phone: enough to read a signed BL, small enough for a weak network. */
export const PHOTO_MAX_SIDE = 1600;

export function fitWithin(
  width: number,
  height: number,
  maxSide: number = PHOTO_MAX_SIDE,
): { w: number; h: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}
