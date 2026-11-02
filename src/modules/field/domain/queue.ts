// The phone's offline queue (REQUIREMENTS-V1 §7): every tap is stored with the phone's own time and a random key, and sent when the
// network is back. The server stores a key once, so a replay (a lost answer, a second tab) changes nothing. A leaf with no import.

export type QueueAction =
  | { kind: 'step'; key: string; tripId: string; step: string; at: string; volumeL?: number }
  | {
      kind: 'emergency';
      key: string;
      tripId: string;
      option: string;
      at: string;
      pctUnloaded?: number;
      note?: string;
    }
  | { kind: 'pump'; key: string; jobId: string; step: string; at: string; m3?: number }
  | { kind: 'ack'; key: string; instructionId: string; at: string };

export type SyncOutcome =
  | { key: string; status: 'recorded' | 'replayed' }
  /** `retry`: try again later (the plant has not loaded yet); anything else is final and the tap is dropped from the queue. */
  | { key: string; status: 'rejected'; code: string; retry: boolean };

/** A new key for a tap: random, so two taps never share one and a replay of the same tap always does. */
export function newKey(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  return Array.from(random(12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function enqueue(queue: readonly QueueAction[], action: QueueAction): QueueAction[] {
  return queue.some((q) => q.key === action.key) ? [...queue] : [...queue, action];
}

/**
 * The queue after a sync: what the server stored (or already had) leaves, a final refusal leaves, a retryable refusal stays in
 * place. Order is kept: later taps of a rotation are never sent before the earlier ones.
 */
export function applyOutcomes(
  queue: readonly QueueAction[],
  outcomes: readonly SyncOutcome[],
): QueueAction[] {
  const byKey = new Map(outcomes.map((o) => [o.key, o]));
  return queue.filter((a) => {
    const o = byKey.get(a.key);
    if (!o) return true;
    return o.status === 'rejected' && o.retry;
  });
}

export function parseQueue(raw: string | null): QueueAction[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? (v.filter(
          (a) => a && typeof a === 'object' && typeof (a as QueueAction).key === 'string',
        ) as QueueAction[])
      : [];
  } catch {
    return [];
  }
}
