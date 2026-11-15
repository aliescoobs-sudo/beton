/**
 * T16 G6 (SPEC-cost-margin §5): the integer arithmetic of the BL cost snapshot, as pure functions. The database writes the snapshot (write_bl_cost_snapshot, migration 0234) and
 * this module is its twin in code: tests/t16-cost-snapshot.int.test.ts proves the two agree on ties, negatives and big products. Integers only (bigint, the products overflow a
 * double), ONE rounding per element, half away from zero. AI never computes money. No rate, price or norm is a constant here: every figure is an argument.
 */

/** num / den rounded to the nearest integer, a tie going away from zero. `den` must be positive. */
export function mulDivRound(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('mulDivRound: the denominator must be positive');
  return num >= 0n ? (2n * num + den) / (2n * den) : -((2n * -num + den) / (2n * den));
}

/** One recette line: dose (base units per m3) x litres x delivered price per purchase unit / (1000 litres per m3 x base units per purchase unit). One rounding. */
export function materialsLineCentimes(p: {
  qtyPerM3: bigint;
  volumeL: bigint;
  priceCentimes: bigint;
  transportCentimes: bigint;
  factorToBase: bigint;
}): bigint {
  return mulDivRound(
    p.qtyPerM3 * p.volumeL * (p.priceCentimes + p.transportCentimes),
    1000n * p.factorToBase,
  );
}

/** The fuel of one trip: millilitres x centimes per litre / 1000 millilitres per litre. */
export const tripFuelCentimes = (perTripMl: bigint, dieselCentimesPerL: bigint): bigint =>
  mulDivRound(perTripMl * dieselCentimesPerL, 1000n);

/** A per-m3 rate applied to a volume in litres. */
export const ratePerM3Centimes = (centimesPerM3: bigint, volumeL: bigint): bigint =>
  mulDivRound(centimesPerM3 * volumeL, 1000n);

export interface CostBlocks {
  materials: bigint;
  delivery: bigint;
  pump: bigint;
  plant: bigint;
  overheads: bigint;
  total: bigint;
}

/** The five blocks of a load; a null input is a missing one and costs 0 (the snapshot lists it, it never substitutes a value). The pump block exists for POMPE only. */
export function costBlocks(p: {
  volumeL: bigint;
  method: 'GOULOTTE' | 'POMPE' | null;
  materialsLines: readonly bigint[];
  perTripMl: bigint | null;
  dieselCentimesPerL: bigint | null;
  deliveryOtherPerM3: bigint | null;
  pumpPerM3: bigint | null;
  plantPerM3: bigint | null;
  overheadPerM3: bigint | null;
}): CostBlocks {
  const materials = p.materialsLines.reduce((a, b) => a + b, 0n);
  const fuel =
    p.perTripMl !== null && p.dieselCentimesPerL !== null
      ? tripFuelCentimes(p.perTripMl, p.dieselCentimesPerL)
      : 0n;
  const other = p.deliveryOtherPerM3 === null ? 0n : ratePerM3Centimes(p.deliveryOtherPerM3, p.volumeL);
  const delivery = fuel + other;
  const pump = p.method === 'POMPE' && p.pumpPerM3 !== null ? ratePerM3Centimes(p.pumpPerM3, p.volumeL) : 0n;
  const plant = p.plantPerM3 === null ? 0n : ratePerM3Centimes(p.plantPerM3, p.volumeL);
  const overheads = p.overheadPerM3 === null ? 0n : ratePerM3Centimes(p.overheadPerM3, p.volumeL);
  return {
    materials,
    delivery,
    pump,
    plant,
    overheads,
    total: materials + delivery + pump + plant + overheads,
  };
}

/** T17 G9 (SPEC-cost-margin §6): the sale price HT of a BL line, the order's unit price HT per m3 x litres / 1000, one rounding (the way an invoice line is made). Signed with the litres. */
export const salePriceCentimes = (unitPriceHtCentimesPerM3: bigint, volumeL: bigint): bigint =>
  mulDivRound(unitPriceHtCentimesPerM3 * volumeL, 1000n);

export interface Margins {
  /** M1 on materials = price - materials. */
  m1: bigint;
  /** M2 after delivery = price - materials - delivery - pump (the pump block is 0 for GOULOTTE). */
  m2: bigint;
  /** M3 full = price - the five blocks. */
  m3: bigint;
}

/** The three margins of a price and its blocks (centimes). Plain subtraction: nothing is rounded, so the sum of the per-BL margins is the margin of the sum. */
export const marginsOf = (price: bigint, blocks: CostBlocks): Margins => ({
  m1: price - blocks.materials,
  m2: price - blocks.materials - blocks.delivery - blocks.pump,
  m3: price - blocks.total,
});

/** A margin in basis points of the price (10 000 bp = 100 %), half away from zero; null when the price is not positive. */
export const marginBp = (margin: bigint, price: bigint): bigint | null =>
  price > 0n ? mulDivRound(margin * 10_000n, price) : null;

/** An amount per m3 from a total and the litres: the display figure only (a total is always a sum of per-BL integers, never a recomputation from this). */
export const perM3Centimes = (totalCentimes: bigint, volumeL: bigint): bigint | null =>
  volumeL > 0n ? mulDivRound(totalCentimes * 1000n, volumeL) : null;
