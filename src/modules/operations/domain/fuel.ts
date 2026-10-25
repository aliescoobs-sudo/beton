import { type Centimes, centimes, mulDivRound } from '@/lib/money';

/**
 * Fuel per truck (SPEC-operations §7.3, AC-OPS-22). Pure. Quantities (litres, kilometres, litres per m³) are read by the
 * plant and the partner; money (the average price, the cost of a truck's fuel, the cost per m³) is computed apart, from the
 * purchases, and only the owner and support receive it. Litres are integers in millilitres.
 */
export interface FuelFill {
  truckId: string;
  date: string;
  litresMl: number;
  /** Odometer reading at the fill, in km; null when not read. */
  odometerKm: number | null;
}

export interface FuelPurchase {
  litresMl: number;
  totalCentimes: Centimes;
}

/** A load's m³ attributed to its truck (litres of concrete; negative on a cancellation). */
export interface TruckVolume {
  truckId: string;
  volumeL: number;
}

export interface TruckFuelQuantities {
  truckId: string;
  fills: number;
  litresMl: number;
  /** Distance between the first and the last odometer reading of the period; null with fewer than two readings. */
  km: number | null;
  /** Fuel burnt over that distance: every fill after the first reading (the first tank was burnt before it). */
  litresMlOverKm: number | null;
  /** Millilitres per 100 km, rounded; null when `km` is. */
  mlPer100Km: number | null;
  /** Concrete delivered by the truck in the period (litres). */
  deliveredL: number;
  /** Millilitres of fuel per m³ delivered, rounded; null when nothing was delivered. */
  mlPerM3: number | null;
}

const roundDiv = (num: number, den: number): number => Math.floor((num * 2 + den) / (den * 2));

/** Quantities per truck over a period (the fills and the loads of the period are the caller's selection). */
export function fuelQuantities(
  fills: readonly FuelFill[],
  volumes: readonly TruckVolume[],
): TruckFuelQuantities[] {
  const trucks = new Set([...fills.map((f) => f.truckId), ...volumes.map((v) => v.truckId)]);
  return [...trucks].sort().map((truckId) => {
    const own = fills.filter((f) => f.truckId === truckId);
    const read = own
      .filter((f) => f.odometerKm !== null)
      .sort((a, b) => (a.odometerKm as number) - (b.odometerKm as number) || a.date.localeCompare(b.date));
    const first = read[0];
    const last = read[read.length - 1];
    const km =
      read.length >= 2 && first && last ? (last.odometerKm as number) - (first.odometerKm as number) : null;
    const litresMlOverKm =
      km !== null && km > 0 && first ? read.slice(1).reduce((s, f) => s + f.litresMl, 0) : null;
    const litresMl = own.reduce((s, f) => s + f.litresMl, 0);
    const deliveredL = volumes.filter((v) => v.truckId === truckId).reduce((s, v) => s + v.volumeL, 0);
    return {
      truckId,
      fills: own.length,
      litresMl,
      km,
      litresMlOverKm,
      mlPer100Km:
        km !== null && km > 0 && litresMlOverKm !== null ? roundDiv(litresMlOverKm * 100, km) : null,
      deliveredL,
      mlPerM3: deliveredL > 0 ? roundDiv(litresMl * 1000, deliveredL) : null,
    };
  });
}

export interface FuelPrice {
  /** Σ purchases, Σ litres bought. */
  totalCentimes: Centimes;
  litresMl: number;
  /** Centimes per litre, rounded: for display only (the cost below uses the exact ratio). */
  centimesPerLitre: Centimes | null;
}

/** The average price of the fuel bought: Σ amount ÷ Σ litres. */
export function fuelPrice(purchases: readonly FuelPurchase[]): FuelPrice {
  let total = 0;
  let litres = 0;
  for (const p of purchases) {
    total += p.totalCentimes as number;
    litres += p.litresMl;
  }
  return {
    totalCentimes: centimes(total),
    litresMl: litres,
    centimesPerLitre: litres > 0 ? mulDivRound(centimes(total), 1000, litres) : null,
  };
}

export interface TruckFuelCost {
  truckId: string;
  /** The truck's litres at the average price: Σ amount × litres ÷ Σ litres, one rounding. Null without a price. */
  costCentimes: Centimes | null;
  /** The cost per m³ delivered: one rounding; null without a cost or without a delivery. */
  costPerM3Centimes: Centimes | null;
}

/** Money per truck (owner and support only). */
export function fuelCosts(quantities: readonly TruckFuelQuantities[], price: FuelPrice): TruckFuelCost[] {
  return quantities.map((q) => {
    const cost = price.litresMl > 0 ? mulDivRound(price.totalCentimes, q.litresMl, price.litresMl) : null;
    return {
      truckId: q.truckId,
      costCentimes: cost,
      costPerM3Centimes: cost !== null && q.deliveredL > 0 ? mulDivRound(cost, 1000, q.deliveredL) : null,
    };
  });
}
