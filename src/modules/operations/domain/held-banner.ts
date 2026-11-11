/**
 * R18-08: what the invoice queue page says about the deliveries held back from billing. A count that could not be taken (an error, a refusal,
 * an invalid range) is "unavailable", never zero: the page must not tell the office that nothing is held when it does not know.
 */
export type HeldBanner = { kind: 'unavailable' } | { kind: 'none' } | { kind: 'held'; count: number };

export function heldBanner(result: { ok: boolean; value?: number } | null | undefined): HeldBanner {
  if (
    !result ||
    !result.ok ||
    typeof result.value !== 'number' ||
    !Number.isInteger(result.value) ||
    result.value < 0
  )
    return { kind: 'unavailable' };
  return result.value === 0 ? { kind: 'none' } : { kind: 'held', count: result.value };
}
