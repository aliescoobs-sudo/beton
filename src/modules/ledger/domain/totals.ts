import { addCentimes, type Centimes, mulDivRound } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';

export interface Totals {
  totalHt: Centimes;
  totalVat: Centimes;
  totalTtc: Centimes;
}

export type TotalsError = 'INVALID_VOLUME' | 'INVALID_PRICE' | 'INVALID_VAT_RATE';

const LITRES_PER_M3 = 1000;
/** Basis points: 10 000 bp = 100 %. The VAT rate is always passed in (stored per document, parameter `vat_rate_bp`). */
const BP_DENOMINATOR = 10_000;

/**
 * Totals of an order or a document line: HT = price per m³ × litres / 1000, VAT = HT × rate (bp) / 10 000, TTC = HT + VAT.
 * Each of the two fractions is rounded once, half away from zero (`mulDivRound`); the sum is exact.
 */
export function computeTotals(
  volumeL: number,
  unitPriceHtPerM3: Centimes,
  vatRateBp: number,
): Result<Totals, TotalsError> {
  if (!Number.isSafeInteger(volumeL) || volumeL <= 0) return err('INVALID_VOLUME');
  if (!Number.isSafeInteger(unitPriceHtPerM3) || unitPriceHtPerM3 <= 0) return err('INVALID_PRICE');
  if (!Number.isSafeInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > BP_DENOMINATOR) {
    return err('INVALID_VAT_RATE');
  }
  const totalHt = mulDivRound(unitPriceHtPerM3, volumeL, LITRES_PER_M3);
  const totalVat = mulDivRound(totalHt, vatRateBp, BP_DENOMINATOR);
  return ok({ totalHt, totalVat, totalTtc: addCentimes(totalHt, totalVat) });
}
