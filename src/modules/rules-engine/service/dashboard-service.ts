import type pg from 'pg';
import { type CashPosition, getCashPosition, listInvoices } from '@/modules/ledger';
import { type ExcessView, listExcesses, listLoadableOrders, type LoadableOrder } from '@/modules/operations';
import { can, inRequest, type SessionUser } from '@/modules/platform-security';
import {
  type AlertOptions,
  type AlertView,
  type BlackDay,
  type EngineParams,
  type ForecastDay,
  type LowestDay,
  type OverdueReceivable,
  type PersistedAlert,
  type RuleHit,
  type StockRisk,
  viewAlerts,
} from '../domain';
import { readPersistedAlerts, syncAlerts } from './alerts-service';
import { type DecisionView, listDecisions } from './decision-service';
import { computeRun } from './run';

/** Everything the owner's "Aujourd'hui" shows, as plain data: the screen formats, it computes nothing. */
export interface DashboardView {
  today: string;
  horizonDays: number;
  threshold: number;
  cash: CashPosition;
  forecast: ForecastDay[];
  lowest: LowestDay | null;
  black: BlackDay | null;
  alerts: AlertView[];
  options: Record<string, AlertOptions>;
  decisions: Record<string, DecisionView[]>;
  overdue: OverdueReceivable[];
  /** Live invoices not fully paid, from what each order's payments cover (derived, never stored). */
  invoices: { unpaid: number; partial: number; openCentimes: number };
  stock: StockRisk;
  loads: LoadableOrder[];
  /** Loads that went past their order and that the owner has not confirmed yet (billed at the order's price once he does). */
  excesses: ExcessView[];
  /** The owner's visit stores what the engine sees today (first detection); support only reads. */
  canDecide: boolean;
}

/**
 * The dashboard of the owner and support (`cash.read`): one run of the engine, the alerts with their history, the options
 * and the decisions already taken. For the owner the run first stores what is new (the day a condition was first seen is
 * what proves "detected N days ahead", S1); the support role reads without writing (DECISIONS 81).
 */
export async function loadDashboard(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string; params: EngineParams },
): Promise<DashboardView> {
  const run = await computeRun(appPool, actor, deps.today, deps.params);
  if (actor.role === 'owner') await syncAlerts(appPool, actor, run.hits, deps.today);
  const persisted: PersistedAlert[] = await inRequest(appPool, actor, readPersistedAlerts);
  const alerts = viewAlerts(run.hits as RuleHit[], persisted, deps.today);
  const decisions = await listDecisions(appPool, actor);
  const byAlert: Record<string, DecisionView[]> = {};
  for (const d of decisions) (byAlert[d.alertKey] ??= []).push(d);
  const cash = await getCashPosition(appPool, actor);
  const live = can(actor.role, 'invoices.read') ? await listInvoices(appPool, actor) : [];
  const open = live.filter((i) => i.paymentState === 'unpaid' || i.paymentState === 'partial');
  const loads = can(actor.role, 'deliveries.read')
    ? await listLoadableOrders(appPool, actor, deps.today).catch(() => [])
    : [];
  const excesses = can(actor.role, 'deliveries.excess_read')
    ? (await listExcesses(appPool, actor).catch(() => [])).filter((x) => !x.confirmed)
    : [];
  return {
    today: deps.today,
    horizonDays: deps.params.horizonDays,
    threshold: deps.params.threshold,
    cash,
    forecast: run.forecast,
    lowest: run.lowest,
    black: run.black,
    alerts,
    options: Object.fromEntries(run.options),
    decisions: byAlert,
    overdue: run.overdue,
    invoices: {
      unpaid: open.filter((i) => i.paymentState === 'unpaid').length,
      partial: open.filter((i) => i.paymentState === 'partial').length,
      openCentimes: open.reduce((s, i) => s + (i.totalTtcCentimes - i.paidCentimes), 0),
    },
    stock: run.stock,
    loads,
    excesses,
    canDecide: can(actor.role, 'cash.decide'),
  };
}

/** What office, plant and partner see instead: no money, no forecast (DECISIONS 81); loads and the stock risk. */
export interface TodayOpsView {
  today: string;
  horizonDays: number;
  loads: LoadableOrder[];
  /** Null for office: it has no stock read. */
  stock: StockRisk | null;
  alerts: AlertView[];
  options: Record<string, AlertOptions>;
}

export async function loadTodayOps(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string; params: EngineParams },
): Promise<TodayOpsView> {
  const loads = can(actor.role, 'deliveries.read')
    ? await listLoadableOrders(appPool, actor, deps.today).catch(() => [])
    : [];
  if (!can(actor.role, 'stock.read'))
    return {
      today: deps.today,
      horizonDays: deps.params.horizonDays,
      loads,
      stock: null,
      alerts: [],
      options: {},
    };
  // Without money facts only the stock rules run: no cash figure can come out of this path.
  const run = await computeRun(appPool, actor, deps.today, deps.params);
  return {
    today: deps.today,
    horizonDays: deps.params.horizonDays,
    loads,
    stock: run.stock,
    alerts: viewAlerts(
      run.hits.filter((h) => h.ruleId === 'STOCK-SHORTAGE' || h.ruleId === 'STOCK-LOW'),
      [],
      deps.today,
    ),
    options: Object.fromEntries(run.options),
  };
}
