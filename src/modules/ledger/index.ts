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
export {
  cancelPurchase,
  type CancelPurchaseError,
  createPurchase,
  type CreatedPurchase,
  insertPurchaseRows,
  getPurchaseDetail,
  listPurchases,
  type PurchaseDetail,
  type PurchaseError,
  type PurchaseView,
} from './service/purchase-service';
export {
  cancelInvoice,
  type CancelInvoiceError,
  createInvoice,
  type CreatedInvoice,
  type InvoiceError,
  getInvoiceDocument,
  insertCreditNoteRows,
  type InvoiceDocument,
  insertInvoiceRows,
  type InvoiceView,
  listInvoices,
} from './service/invoice-service';
export { getCompanyProfile, listCompanyProfiles, saveCompanyProfile } from './service/company-service';
export {
  type AccountingExport,
  buildAccountingExport,
  EXPORT_FILES,
  type ExportError,
  type ExportFile,
} from './service/accounting-export';
export {
  createQuote,
  type CreatedQuote,
  getQuote,
  insertQuoteRows,
  listQuotes,
  type QuoteError,
  type QuoteView,
} from './service/quote-service';
export { legalDeadlines } from './service/deadlines-service';
export { getOrderDetail, listOrders, type OrderDetail, type OrderRow } from './service/order-read';
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
  bounceInstrument,
  cancelInstrument,
  clearInstrument,
  disputeInstrument,
  regularizeInstrument,
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
export {
  addPartyOpeningBalance,
  enterOpeningDate,
  getOpeningState,
  type OpeningError,
  type OpeningState,
} from './service/opening-service';
export {
  type AccountRow,
  getClientStatement,
  getSupplierStatement,
  listAccounts,
  type PartyKind,
  type PartyStatement,
} from './service/statement-service';
