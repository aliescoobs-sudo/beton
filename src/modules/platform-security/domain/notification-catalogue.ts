/**
 * R5 (REQUIREMENTS-V1 §13): the event catalogue. Every notification kind, its default severity and the screen it opens.
 * The database holds the same list in a check constraint (tests/notifications.int.test.ts proves they agree). A notification
 * carries codes and kinds, never an amount; the text is drawn from the person's language by `notifications.kind.<kind>`.
 */
export const NOTIFICATION_CATALOGUE = {
  emergency: { severity: 'urgent', link: '/emergencies' },
  driver_instruction: { severity: 'urgent', link: '/driver' },
  approval_pending: { severity: 'important', link: '/approvals' },
  stock_low: { severity: 'important', link: '/alerts' },
  stock_shortage: { severity: 'urgent', link: '/alerts' },
  cheque_bounced: { severity: 'urgent', link: '/alerts' },
  receivable_due: { severity: 'important', link: '/alerts' },
  receivable_overdue: { severity: 'important', link: '/alerts' },
  payable_due: { severity: 'important', link: '/alerts' },
  cash_deficit: { severity: 'urgent', link: '/alerts' },
  invoice_month_end: { severity: 'important', link: '/alerts' },
  law6921: { severity: 'important', link: '/alerts' },
  day_conflict: { severity: 'important', link: '/alerts' },
  shipment_delay: { severity: 'important', link: '/trips' },
  receipt_late: { severity: 'important', link: '/receipts' },
  order_cancelled: { severity: 'important', link: '/orders' },
  cancel_do_not_load: { severity: 'urgent', link: '/trips' },
  redirect_proposal: { severity: 'important', link: '/cancellations' },
  loss_recorded: { severity: 'important', link: '/cancellations' },
  receipt_rejected: { severity: 'important', link: '/receipts' },
  receipt_variance: { severity: 'important', link: '/receipts' },
  reorder_request: { severity: 'important', link: '/stock' },
  stock_count_variance: { severity: 'important', link: '/stock' },
  stock_count_decided: { severity: 'important', link: '/stock' },
  transfer: { severity: 'info', link: '/transfers' },
  day_close_blocking: { severity: 'important', link: '/day-close' },
  document_request: { severity: 'important', link: '/approvals' },
  test: { severity: 'info', link: '/notifications' },
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_CATALOGUE;
export const NOTIFICATION_KINDS = Object.keys(NOTIFICATION_CATALOGUE) as NotificationKind[];
export type NotificationSeverity = 'info' | 'important' | 'urgent';
