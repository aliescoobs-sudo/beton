// Public surface of the owner dashboard. Routes import only from here.
export { AlertReport, type ReportActions } from './ui/alert-report';
export { AlertsList } from './ui/alerts-list';
export { OpsToday } from './ui/ops-today';
export { OwnerToday } from './ui/owner-today';
export { StockSummary } from './ui/stock-summary';
export { renderDrafts } from './ui/drafts-text';
export type { T } from './ui/describe';
export type { ApplyInput, ApplyResult } from './ui/option-actions';
export type { ReclassifyResult } from './ui/reclassify-form';
export { formatDay, qtyText } from './ui/format';
