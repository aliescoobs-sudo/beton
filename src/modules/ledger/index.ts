// Public surface of the ledger. Other modules import only from here.
export * from './domain';
export { nextDocNumber } from './service/doc-number';
export {
  createOrder,
  type CreatedOrder,
  type OrderError,
  type OrderPreview,
  previewOrder,
} from './service/order-service';
export { cancelOrder, type CancelOrderError, type CancelledOrder } from './service/order-reversal';
export {
  type CorrectionRequest,
  listCorrectionRequests,
  requestCorrection,
} from './service/correction-service';
export {
  createMoneyAccount,
  listMoneyAccounts,
  type MoneyAccount,
  type MoneyAccountError,
  setOpeningBalance,
} from './service/money-account-service';
export {
  cancelInstrument,
  clearInstrument,
  depositInstruments,
  type InstrumentError,
  type InstrumentEventView,
  type InstrumentRef,
  type InstrumentView,
  issueInstrument,
  listInstruments,
  receiveInstrument,
  reverseMovement,
} from './service/instrument-service';
export {
  allocate,
  type AllocationError,
  type ItemCoverage,
  orderCoverage,
  unallocate,
} from './service/allocation-service';
export { getCashPosition } from './service/cash-service';
