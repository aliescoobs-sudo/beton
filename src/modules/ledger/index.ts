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
