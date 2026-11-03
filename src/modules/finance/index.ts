// Public finance API: authenticated caller, deterministic calculations, no external provider.
export { executeFinance, financeCommand, type FinanceCommand } from './service/commands';
export {
  financeEnabled,
  FinanceUnavailable,
  type FinanceActor,
  type FinanceSession,
} from './service/request';
export { getFinanceReport, getFinanceCash, validRange } from './service/report-service';
export { exportAccountant } from './service/accountant-export';
export { canFinance, FINANCE_PERMISSIONS } from './domain/permissions';
export { periodRange, addMonths, type Period } from './domain/period';
export {
  steelFlows,
  cashForecast,
  suggestSteel,
  rankSteelOptions,
  type CashFlow,
  type SteelTerms,
} from './domain/forecast';

export { getFinanceReferences } from './service/reference-service';
export { simulateSteel } from './service/steel-scenario';
