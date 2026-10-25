import { type Centimes, centimes } from '@/lib/money';
import { type Calendar, forecastDates } from './calendar';
import { detectBlackDay, type BlackDay } from './black-day';
import { buildFlows } from './flows';
import { forecastCash, type ForecastDay, lowestDay, type LowestDay } from './forecast';
import {
  collectOptions,
  generateCashOptions,
  type InformationalOption,
  type OptionParams,
  type OptionsResult,
} from './options';
import { alertKey, type BouncedFact, type DeadlineFact, evaluateRules, type RuleHit } from './rules';
import { generateStockOptions, type StockOption } from './stock-options';
import {
  type ComponentProjection,
  projectStock,
  type StockRisk,
  type StockRiskInput,
  type SupplierHint,
} from './stock-risk';
import type { CashFlow, InstrumentFact, OverdueReceivable, PlanItemFact } from './types';
import type { Change } from './what-if';

export interface EngineParams {
  /** Working days after today (7 or 14). */
  horizonDays: number;
  threshold: Centimes;
  leadDays: number;
  legalReminderDays: number;
  bounceReminderDays: readonly number[];
  clearingDelayDays: number;
  postponeWorkingDays: number;
  advanceExtraBp: number;
  discountRateBp: number;
  splitBp: number;
  vatRateBp: number;
  purchaseLeadDays: number;
  /** Safety days added to a supplier's lead time before a reorder is suggested (O12). */
  reorderMarginDays: number;
  calendar: Calendar;
}

/** Everything the engine reads, already gathered by a service. Same input, same output (AC-RE-01). */
export interface MoneyFacts {
  /** Cleared cash and bank balances today (R9). */
  encaisse: Centimes;
  instruments: readonly InstrumentFact[];
  items: readonly PlanItemFact[];
  bounced: readonly BouncedFact[];
  deadlines: readonly DeadlineFact[];
}

export interface StockFacts {
  components: StockRiskInput['components'];
  demands: StockRiskInput['demands'];
  recettes: StockRiskInput['recettes'];
  receipts: StockRiskInput['receipts'];
  /** The preferred supplier per component (last purchase). */
  suppliers: ReadonlyMap<string, SupplierHint>;
}

/** The options an alert carries, by the key of the alert. */
export interface AlertOptions {
  cash: OptionsResult | null;
  stock: StockOption[];
  /** An overdue client to chase: counted nowhere until it is paid. */
  collect: InformationalOption | null;
}

export interface CashResult {
  encaisse: Centimes;
  forecast: ForecastDay[];
  lowest: LowestDay | null;
  black: BlackDay | null;
  flows: CashFlow[];
  overdue: OverdueReceivable[];
  hits: RuleHit[];
  options: Map<string, AlertOptions>;
}

const optionParams = (today: string, encaisse: Centimes, p: EngineParams): OptionParams => ({
  today,
  calendar: p.calendar,
  horizonDays: p.horizonDays,
  encaisse,
  threshold: p.threshold,
  clearingDelayDays: p.clearingDelayDays,
  postponeWorkingDays: p.postponeWorkingDays,
  advanceExtraBp: p.advanceExtraBp,
  discountRateBp: p.discountRateBp,
});

/** The stock side alone: it carries no money, so partner and plant can have it (DECISIONS 81). */
export function runStock(
  today: string,
  facts: StockFacts,
  p: EngineParams,
): { risk: StockRisk; input: StockRiskInput } {
  const input: StockRiskInput = {
    today,
    horizonDays: p.horizonDays,
    calendar: p.calendar,
    components: facts.components,
    demands: facts.demands,
    recettes: facts.recettes,
    receipts: facts.receipts,
  };
  return { risk: projectStock(input), input };
}

/**
 * One deterministic run (AC-RE-01): flows, forecast, the black day, every alert of the catalogue, and for each deficit,
 * day conflict or shortage the ranked options with their computed coverage. Money facts are optional: without them only
 * the stock rules run (the plant's view).
 */
export function runEngine(
  today: string,
  money: MoneyFacts | null,
  stockFacts: StockFacts,
  p: EngineParams,
): CashResult & { stock: StockRisk; stockInput: StockRiskInput; dates: string[] } {
  const { risk, input: stockInput } = runStock(today, stockFacts, p);
  const dates = forecastDates(today, p.horizonDays, p.calendar);
  const options = new Map<string, AlertOptions>();

  const empty: CashResult = {
    encaisse: centimes(0),
    forecast: [],
    lowest: null,
    black: null,
    flows: [],
    overdue: [],
    hits: [],
    options,
  };
  const cash: CashResult = money ? runMoney(today, money, risk, p) : empty;

  // Stock rules (no money) when there are no money facts.
  if (!money) {
    cash.hits = evaluateRules({
      today,
      leadDays: p.leadDays,
      legalReminderDays: p.legalReminderDays,
      bounceReminderDays: p.bounceReminderDays,
      threshold: p.threshold,
      forecast: [],
      flows: [],
      overdue: [],
      bounced: [],
      stock: risk,
      deadlines: [],
    }).filter((h) => h.ruleId === 'STOCK-SHORTAGE' || h.ruleId === 'STOCK-LOW');
  }

  // Stock options for every shortage.
  for (const h of cash.hits) {
    if (h.ruleId !== 'STOCK-SHORTAGE') continue;
    const projection = risk.components.find((c) => c.componentId === h.params.componentId);
    if (!projection) continue;
    const found = generateStockOptions(
      stockInput,
      projection,
      stockFacts.suppliers.get(projection.componentId) ?? null,
      {
        today,
        calendar: p.calendar,
        splitBp: p.splitBp,
        vatRateBp: p.vatRateBp,
        purchaseLeadDays: p.purchaseLeadDays,
      },
    );
    cash.options.set(alertKey(h), { cash: null, stock: found, collect: null });
  }

  // A day conflict also gets the cash options, with the emergency purchase counted as an outflow of that day.
  if (money) addConflictOptions(today, cash, risk, stockFacts, stockInput, p);

  return { ...cash, stock: risk, stockInput, dates };
}

function runMoney(today: string, money: MoneyFacts, risk: StockRisk, p: EngineParams): CashResult {
  const { flows, overdue } = buildFlows(money.instruments, money.items, {
    today,
    clearingDelayDays: p.clearingDelayDays,
    calendar: p.calendar,
  });
  const forecast = forecastCash({
    today,
    horizonDays: p.horizonDays,
    encaisse: money.encaisse,
    threshold: p.threshold,
    flows,
    calendar: p.calendar,
  });
  const hits = evaluateRules({
    today,
    leadDays: p.leadDays,
    legalReminderDays: p.legalReminderDays,
    bounceReminderDays: p.bounceReminderDays,
    threshold: p.threshold,
    forecast,
    flows,
    overdue,
    bounced: money.bounced,
    stock: risk,
    deadlines: money.deadlines,
  });
  const options = new Map<string, AlertOptions>();
  const op = optionParams(today, money.encaisse, p);
  for (const h of hits) {
    if (h.ruleId === 'CASH-DEFICIT') {
      options.set(alertKey(h), {
        cash: generateCashOptions(flows, overdue, h.targetDate, op),
        stock: [],
        collect: null,
      });
    }
  }
  // Each overdue receivable offers to chase that client (the client's whole overdue list, not counted until paid).
  const collect = new Map(collectOptions(overdue).map((c) => [c.partyId, c] as const));
  for (const h of hits) {
    if (h.ruleId !== 'RCV-OVERDUE') continue;
    const item = overdue.find((o) => o.id === h.subjectKey);
    const mine = item ? collect.get(item.partyId) : undefined;
    if (mine) options.set(alertKey(h), { cash: null, stock: [], collect: mine });
  }
  return {
    encaisse: money.encaisse,
    forecast,
    lowest: lowestDay(forecast, 'base'),
    black: detectBlackDay(forecast, p.threshold),
    flows,
    overdue,
    hits,
    options,
  };
}

function addConflictOptions(
  today: string,
  cash: CashResult,
  risk: StockRisk,
  stockFacts: StockFacts,
  stockInput: StockRiskInput,
  p: EngineParams,
): void {
  const op = optionParams(today, cash.encaisse, p);
  for (const h of cash.hits) {
    if (h.ruleId !== 'DAY-CONFLICT') continue;
    const baseline: Change[] = [];
    for (const key of h.childKeys) {
      const child = cash.hits.find((x) => alertKey(x) === key);
      if (child?.ruleId !== 'STOCK-SHORTAGE') continue;
      const projection = risk.components.find((c) => c.componentId === child.params.componentId);
      const emergency = projection
        ? generateStockOptions(
            stockInput,
            projection,
            stockFacts.suppliers.get(projection.componentId) ?? null,
            {
              today,
              calendar: p.calendar,
              splitBp: p.splitBp,
              vatRateBp: p.vatRateBp,
              purchaseLeadDays: p.purchaseLeadDays,
            },
          ).find((o) => o.kind === 'EMERGENCY-PURCHASE')
        : undefined;
      if (emergency?.cashImpact && emergency.draft) {
        baseline.push({
          type: 'add',
          flow: {
            id: `draft:${emergency.id}`,
            direction: 'out',
            amount: emergency.cashImpact,
            baseDate: h.targetDate,
            worstDate: h.targetDate,
            certainty: 'committed',
            source: 'plan',
            method: 'transfer',
            instrumentState: null,
            ref: { type: 'purchase', id: emergency.id, code: emergency.draft.supplierCode },
            partyId: emergency.draft.supplierId,
            partyName: emergency.draft.supplierName,
            earlyPresentable: false,
            draft: true,
          },
        });
      }
    }
    cash.options.set(alertKey(h), {
      cash: generateCashOptions(cash.flows, cash.overdue, h.targetDate, op, baseline),
      // The conflict carries its children's stock options too (the report shows both sides).
      stock: h.childKeys.flatMap((key) => cash.options.get(key)?.stock ?? []),
      collect: null,
    });
  }
}

export type { ComponentProjection };
