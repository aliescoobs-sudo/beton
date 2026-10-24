import { scaleQty } from '@/lib/quantity';

/** One line of a recette: base units of a component per m³ of concrete. */
export interface RecetteLineInput {
  componentId: string;
  qtyPerM3: number;
}

export interface ComponentQty {
  componentId: string;
  /** Integer base units (g, mL or L). */
  qtyBase: number;
}

const LITRES_PER_M3 = 1000;

/**
 * What a load takes out of the stock: each recette line × the volume of the load in litres ÷ 1 000, one rounding per
 * line, half away from zero (AC-OPS-02). Pure and deterministic: the service stores the result as facts at the moment of
 * the load, so a later recette version never rewrites history.
 */
export function consumptionForLoad(lines: readonly RecetteLineInput[], volumeL: number): ComponentQty[] {
  if (!Number.isSafeInteger(volumeL) || volumeL <= 0)
    throw new RangeError(`Not a usable load volume: ${volumeL}`);
  return lines.map((l) => ({
    componentId: l.componentId,
    qtyBase: scaleQty(l.qtyPerM3, volumeL, LITRES_PER_M3),
  }));
}
