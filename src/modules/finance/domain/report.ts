import { allocate, subtract, sum } from './money';
export const REPORT_TITLE = 'Résultat de gestion (données enregistrées)';
export type ResultKind =
  'concrete' | 'pumping' | 'material' | 'expense' | 'financing' | 'steel_cost' | 'principal' | 'leasing';
export interface ResultFact {
  id: string;
  date: string;
  plantId: string | null;
  kind: ResultKind;
  amountCentimes: number;
  allocation?: Record<string, number> | null;
}
export interface ResultLine {
  plantId: string | null;
  label: string;
  revenueCentimes: number;
  costsCentimes: number;
  resultCentimes: number;
  principalCentimes: number;
}
export function managementReport(input: {
  from: string;
  to: string;
  plants: { id: string; name: string }[];
  facts: ResultFact[];
  leasingTreatment: 'expense' | 'principal_interest';
  missingValuations?: number;
  excludedRevenueCentimes?: number;
  excludedRevenueCount?: number;
}) {
  const buckets = new Map<string | null, ResultFact[]>([
    [null, []],
    ...input.plants.map((p) => [p.id, []] as [string, ResultFact[]]),
  ]);
  for (const fact of input.facts.filter((f) => f.date >= input.from && f.date <= input.to)) {
    // Financing and steel stay central even if an operational allocation was supplied.
    if (fact.kind === 'financing' || fact.kind === 'steel_cost') buckets.get(null)!.push(fact);
    else if (fact.allocation) {
      for (const [id, amountCentimes] of Object.entries(allocate(fact.amountCentimes, fact.allocation))) {
        if (!buckets.has(id)) throw new Error('UNKNOWN_PLANT');
        buckets.get(id)!.push({ ...fact, amountCentimes });
      }
    } else {
      if (!buckets.has(fact.plantId)) throw new Error('UNKNOWN_PLANT');
      buckets.get(fact.plantId)!.push(fact);
    }
  }
  const line = (plantId: string | null, label: string): ResultLine => {
    const facts = buckets.get(plantId)!;
    const revenueCentimes = sum(
      facts.filter((f) => ['concrete', 'pumping'].includes(f.kind)).map((f) => f.amountCentimes),
    );
    const principal = (f: ResultFact) =>
      f.kind === 'principal' || (f.kind === 'leasing' && input.leasingTreatment === 'principal_interest');
    const costsCentimes = sum(
      facts
        .filter((f) => !['concrete', 'pumping'].includes(f.kind) && !principal(f))
        .map((f) => f.amountCentimes),
    );
    return {
      plantId,
      label,
      revenueCentimes,
      costsCentimes,
      resultCentimes: subtract(revenueCentimes, costsCentimes),
      principalCentimes: sum(facts.filter(principal).map((f) => f.amountCentimes)),
    };
  };
  const plants = input.plants.map((p) => line(p.id, p.name)),
    central = line(null, 'Charges centrales');
  const rows = [...plants, central];
  const total: ResultLine = {
    plantId: null,
    label: 'Total',
    revenueCentimes: sum(rows.map((r) => r.revenueCentimes)),
    costsCentimes: sum(rows.map((r) => r.costsCentimes)),
    resultCentimes: sum(rows.map((r) => r.resultCentimes)),
    principalCentimes: sum(rows.map((r) => r.principalCentimes)),
  };
  const missingValuations = input.missingValuations ?? 0,
    excludedRevenueCentimes = input.excludedRevenueCentimes ?? 0;
  const excludedRevenueCount = input.excludedRevenueCount ?? (excludedRevenueCentimes === 0 ? 0 : 1);
  return {
    title: REPORT_TITLE,
    from: input.from,
    to: input.to,
    plants,
    central,
    total,
    leasingTreatment: input.leasingTreatment,
    missingValuations,
    excludedRevenueCentimes,
    excludedRevenueCount,
    complete: missingValuations === 0 && excludedRevenueCount === 0,
  };
}
