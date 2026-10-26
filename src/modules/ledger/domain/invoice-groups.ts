import { addCentimes, type Centimes, centimes } from '@/lib/money';

export interface InvoiceLineFact {
  blNo: string;
  typeCode: string;
  typeLabel: string;
  volumeL: number;
  unitPriceHtCentimes: number;
  lineHtCentimes: number;
}

export interface InvoiceGroup {
  typeCode: string;
  typeLabel: string;
  unitPriceHtCentimes: number;
  /** Litres, summed; negative on a credit note. */
  volumeL: number;
  /** The sum of the stored lines (each rounded once per load), so the groups always add up to the invoice. */
  amountHtCentimes: Centimes;
  blNos: string[];
}

/**
 * The stored lines (one per load) shown as the document shows them: one line per product and unit price, the quantity summed
 * and the BL numbers listed (AC-INT-06). The same product at two prices stays two lines, since a quantity cannot be summed
 * at two prices. The amount of a group is the sum of its stored lines, never recomputed. Pure.
 */
export function groupInvoiceLines(lines: readonly InvoiceLineFact[]): InvoiceGroup[] {
  const groups = new Map<string, InvoiceGroup>();
  for (const l of lines) {
    const key = `${l.typeCode}\u0000${l.unitPriceHtCentimes}`;
    const g = groups.get(key) ?? {
      typeCode: l.typeCode,
      typeLabel: l.typeLabel,
      unitPriceHtCentimes: l.unitPriceHtCentimes,
      volumeL: 0,
      amountHtCentimes: centimes(0),
      blNos: [],
    };
    g.volumeL += l.volumeL;
    g.amountHtCentimes = addCentimes(g.amountHtCentimes, centimes(l.lineHtCentimes));
    if (!g.blNos.includes(l.blNo)) g.blNos.push(l.blNo);
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => a.typeCode.localeCompare(b.typeCode) || a.unitPriceHtCentimes - b.unitPriceHtCentimes,
  );
}

/** What is left to pay once the advances received are taken off the total; never below zero. */
export function netToPay(totalTtcCentimes: number, advanceCentimes: number): Centimes {
  return centimes(Math.max(0, totalTtcCentimes - advanceCentimes));
}
