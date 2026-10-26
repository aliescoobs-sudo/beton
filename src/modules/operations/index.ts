// Public surface of operations. Other modules import only from here.
export * from './domain';
export {
  type BlReturned,
  cancelLoad,
  type CancelledLoad,
  createLoad,
  type CreatedLoad,
  type DeliveryError,
  type FirstReturn,
  markDelivered,
  recordBlReturn,
} from './service/delivery-service';
export {
  adjustStockAfterCount,
  listStockAdjustments,
  type StockAdjustment,
  type StockCountError,
  type StockCountResult,
  getStockLevels,
  type OpeningStockError,
  setOpeningStock,
  setStockThreshold,
  type StockLevel,
  type ThresholdError,
} from './service/stock-service';
export {
  type DeliveryRow,
  listDeliveries,
  listLoadableOrders,
  type LoadableOrder,
} from './service/plant-views';
export { type DeliveryNote, getDeliveryNote, recordNotePrint } from './service/delivery-note';
export {
  listReceivable,
  type ReceivableLine,
  type ReceivablePurchase,
  type ReceiptError,
  recordReceipt,
  type ReceivedStock,
} from './service/receipt-service';
export { type OpsScenarioResult, seedOperationsScenario } from './service/pilot-ops';
export {
  confirmExcess,
  type ConfirmExcessError,
  type ExcessView,
  listExcesses,
} from './service/excess-service';
export { withinTolerance } from './service/delivery-service';
export {
  archiveDriver,
  createDriver,
  type DispatchDay,
  type DispatchError,
  type DriverRow,
  getDispatchDay,
  listDrivers,
  type SavedDispatch,
  type SavedRotation,
  saveDispatch,
} from './service/dispatch-service';
export { type LossError, recordLoss, type RecordedLoss } from './service/loss-service';
export {
  listTrips,
  type RecordedStep,
  recordTripStep,
  type TripError,
  type TripView,
} from './service/trip-service';
export {
  type ConsumptionComponent,
  type ConsumptionReportView,
  getConsumptionReport,
} from './service/report-service';
export {
  type FuelError,
  type FuelFillRow,
  type FuelMoney,
  type FuelReport,
  type FuelTruckRow,
  getFuelReport,
  listFuelFills,
  recordFuelFill,
  recordFuelPurchase,
} from './service/fuel-service';
export { getVolumeAnalytics, type VolumeAnalytics } from './service/analytics-service';
export { seedOperationsWave2, type Wave2Result } from './service/pilot-ops2';
