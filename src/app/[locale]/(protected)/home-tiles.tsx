import { can, type SessionUser } from '@/modules/platform-security';

/** The entry screens a role may use, as shortcuts (office has no figures to show, only things to enter). */
export function homeShortcuts(user: SessionUser, locale: string, label: (key: string) => string) {
  const all: [string, Parameters<typeof can>[1], string][] = [
    ['/orders/new', 'orders.write', 'newOrder'],
    ['/quotes/new', 'quotes.write', 'newQuote'],
    ['/payments/new', 'instruments.write', 'newPayment'],
    ['/invoices/new', 'invoices.write', 'newInvoice'],
    ['/purchases/new', 'purchases.write', 'newPurchase'],
    ['/loads', 'deliveries.write', 'loads'],
    ['/receipts', 'receipts.write', 'receipts'],
  ];
  return all
    .filter(([, permission]) => can(user.role, permission))
    .map(([path, , key]) => ({ href: `/${locale}${path}`, label: label(key) }));
}
