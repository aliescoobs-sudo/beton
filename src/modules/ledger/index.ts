// Public surface of the ledger. Other modules import only from here.
export * from './domain';
export { nextDocNumber } from './service/doc-number';
export {
  createOrder,
  type CreatedOrder,
  type OrderError,
  type OrderPreview,
  insertOrderRows,
  prepareOrder,
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
export {
  type ApprovalCard,
  type ApprovalError,
  type ClientStanding,
  confirmOrderPrice,
  confirmPricesInBulk,
  type CreditCard,
  getClientStandings,
  getOrderApprovalStates,
  listApprovals,
  type OrderApprovalState,
  type PriceCard,
  releaseOrderHold,
  setCreditLimit,
  listCreditLimits,
  type ClientCreditLimit,
} from './service/approval-service';
export { type InvoicePreview, previewInvoiceFromDeliveries } from './service/invoice-preview';
export { getInvoiceQueue, type QueueClient, type QueueDelivery } from './service/invoice-queue-service';
export { allocateToInvoice, listOpenInvoices, type OpenInvoice } from './service/allocation-service';
export {
  type AvoirCandidate,
  type AvoirError,
  type AvoirView,
  issueAvoir,
  listAvoirCandidates,
  listAvoirs,
} from './service/avoir-service';
export {
  type CreatedSupplierInvoice,
  acceptSupplierInvoiceGaps,
  attachSupplierInvoiceFile,
  type DocumentUpload,
  openSupplierInvoiceFile,
  approveSupplierInvoice,
  createSupplierInvoice,
  type DecisionError,
  getSupplierInvoiceMatch,
  rejectSupplierInvoice,
  getSupplierInvoice,
  listSupplierInvoices,
  type SupplierInvoiceDetail,
  type SupplierInvoiceError,
  type SupplierInvoiceView,
} from './service/supplier-invoice-service';
export { getOrderChain, type OrderChainRow } from './service/order-chain-service';
export {
  decideDisclosure,
  DISCLOSURE_KINDS,
  type DisclosedFigure,
  type DisclosureError,
  type DisclosureKind,
  listMyDisclosures,
  listPendingDisclosures,
  type MyDisclosure,
  type PendingDisclosure,
  requestDisclosure,
  viewDisclosure,
} from './service/disclosure-service';
export {
  DOCUMENT_REQUEST_KINDS,
  type DocumentRequestError,
  type DocumentRequestKind,
  decideDocumentRequest,
  getInvoiceTiming,
  INVOICE_TIMINGS,
  type InvoiceTiming,
  listMyDocumentRequests,
  listPendingDocumentRequests,
  type MyDocumentRequest,
  type PendingDocumentRequest,
  requestDocument,
  getInvoiceSequence,
  setInvoiceSequence,
  setInvoiceTiming,
  releaseDocumentRequest,
  consumeDocumentCopy,
  COPY_REQUEST_KIND,
} from './service/document-request-service';
export {
  getInvoiceForPrint,
  libraryKinds,
  type LibraryEntry,
  listDocumentLibrary,
  mayOpen,
  recordLibraryOpen,
} from './service/document-library';
export { getRelatedDocuments, type RelatedSubject } from './service/related-service';
export { searchDocuments, type SearchError } from './service/search-service';
export { getCompanyProfile, listCompanyProfiles, saveCompanyProfile } from './service/company-service';
export {
  type AccountingExport,
  buildAccountingExport,
  exportFilesFor,
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
  depositInstrumentsIn,
  instrumentFailure,
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
export { type CashDay, getCashDay, getCashPosition } from './service/cash-service';
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
export { avoirPdf, invoicePdf, quotePdf, SPECIMEN, statementPdf, type PdfContext } from './pdf/documents';
export {
  listClientReminders,
  logClientReminder,
  type ReminderError,
  type ReminderView,
} from './service/reminder-service';
export {
  COUNTER_PREFIXES,
  type CounterError,
  type CounterPrefix,
  getDocCounter,
  setDocCounter,
} from './service/counter-service';
export {
  addChargeDocument,
  CHARGE_CATEGORIES,
  CHARGE_MODES,
  type ChargeError,
  type ChargeStatus,
  type ChargeView,
  chargesToCsv,
  decideCharge,
  listCharges,
  markChargePaid,
  recordCharge,
} from './service/charge-service';
export {
  decidePayment,
  type DueTomorrow,
  listDueTomorrow,
  listPaymentRequests,
  listSmallPaymentsForReview,
  type PaymentControlError,
  type PaymentRequestView,
  preparePayment,
  type RequestState,
  type SmallPaymentReview,
} from './service/payment-control-service';
export {
  addClientAlias,
  type ClientAlias,
  type ClientTerms,
  getClientTerms,
  listClientAliases,
  listOrderExtras,
  type OrderExtra,
  type SalesGapError,
  setClientTerms,
} from './service/sales-gap-service';
