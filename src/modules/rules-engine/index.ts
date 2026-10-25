// Public surface of the rules engine. Other modules import only from here.
export * from './domain';
export { engineParams, parseDayList } from './service/params';
export { computeRun, type EngineRun } from './service/run';
export { loadMoneyFacts } from './service/facts-money';
export { loadStockFacts } from './service/facts-stock';
export {
  listPersistedAlerts,
  reclassifyAlert,
  type ReclassifyError,
  syncAlerts,
} from './service/alerts-service';
export {
  type AppliedDecision,
  applyOption,
  type ApplyError,
  type DecisionView,
  listDecisions,
} from './service/decision-service';
export {
  type DashboardView,
  loadDashboard,
  loadTodayOps,
  type TodayOpsView,
} from './service/dashboard-service';
