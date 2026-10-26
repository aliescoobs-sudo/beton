import { describe, expect, it } from 'vitest';
import { PARAMETERS } from '@/modules/platform-security/domain/parameters';
import { gapCount, type MatchLine, matchIsClean } from './supplier-invoice-match';

const line = (flags: MatchLine['flags']): MatchLine => ({
  seq: 1,
  description: 'Ciment',
  purchaseLineId: 'x',
  orderedMilli: 30_000,
  orderedPriceCentimes: 145_000,
  receivedMilli: 30_000,
  invoicedMilli: 30_000,
  cumulativeMilli: 30_000,
  invoicedPriceCentimes: 145_000,
  flags,
});

describe('the match summary (AC-INT-14)', () => {
  it('is clean when no line is flagged, and counts the lines that are', () => {
    expect(matchIsClean([line([]), line([])])).toBe(true);
    expect(matchIsClean([line([]), line(['PRICE'])])).toBe(false);
    expect(gapCount([line(['PRICE', 'QTY_OVER_RECEIVED']), line([]), line(['NOT_ON_ORDER'])])).toBe(2);
  });
});

describe('the tolerances are parameters (AC-INT-14)', () => {
  it('are in the parameter registry, with defaults the database function uses when the owner has set nothing', () => {
    // the SQL fallback: db/migrations/0071 reads `parameter` and falls back to 100 and 50
    expect(PARAMETERS.match_qty_tolerance_bp.default).toBe(100);
    expect(PARAMETERS.match_price_tolerance_bp.default).toBe(50);
    expect(PARAMETERS.match_qty_tolerance_bp.schema.safeParse(2001).success).toBe(false);
    expect(PARAMETERS.match_price_tolerance_bp.schema.safeParse(-1).success).toBe(false);
  });
});
