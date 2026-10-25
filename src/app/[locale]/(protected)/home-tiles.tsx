import { can, type SessionUser } from '@/modules/platform-security';
import { Card, Money, StatusPill } from '@/ui';

interface Tile {
  id: string;
  href: string;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'late' | 'due' | 'paid' | 'neutral';
  toneLabel?: string;
}

/**
 * "Aujourd'hui": a few facts read from the same services as the screens they link to (nothing computed here), for the roles
 * that may read them. An interim home: the full owner dashboard (forecast, alerts) belongs to the owner-dashboard module.
 * Returns the tiles and whether there is anything at all to show (a brand-new database shows the invitation instead).
 */
export async function homeTiles(
  user: SessionUser,
  locale: string,
): Promise<{ tiles: Tile[]; hasData: boolean }> {
  const pool = getPool('app');
  const today = (await getRequestClock()).today();
  const t = await getTranslations('shell.home');
  const tiles: Tile[] = [];
  const push = (tile: Tile) =>
    tiles.push({
      ...tile,
      toneLabel: tile.tone && tile.tone !== 'neutral' ? t(`tones.${tile.tone}`) : undefined,
    });
  let hasData = false;

  if (can(user.role, 'deliveries.read')) {
    const due = await listLoadableOrders(pool, user, today).catch(() => []);
    if (due.length > 0) hasData = true;
    push({
      id: 'loads',
      href: `/${locale}/loads`,
      label: t('loads'),
      value: due.length,
      hint: t('loadsHint'),
      tone: due.length > 0 ? 'due' : 'neutral',
    });
  }
  if (can(user.role, 'stock.read')) {
    const levels = await getStockLevels(pool, user).catch(() => []);
    const low = levels.filter((l) => l.status !== 'ok');
    if (levels.some((l) => l.level !== 0)) hasData = true;
    push({
      id: 'stock',
      href: `/${locale}/stock`,
      label: t('stock'),
      value: low.length,
      hint:
        low.length > 0 ? low.map((l) => (locale === 'ar' ? l.nameAr : l.nameFr)).join(', ') : t('stockOk'),
      tone: low.length > 0 ? 'late' : 'paid',
    });
  }
  if (can(user.role, 'cash.read')) {
    const cash = await getCashPosition(pool, user).catch(() => null);
    if (cash) {
      hasData = true;
      push({
        id: 'cash',
        href: `/${locale}/cash`,
        label: t('cash'),
        value: <Money centimes={Number(cash.real)} />,
        hint: (
          <>
            {t('cashTotal')} <Money centimes={Number(cash.total)} />
          </>
        ),
      });
    }
  }
  if (can(user.role, 'due_items.read')) {
    const deadlines = await legalDeadlines(pool, user, { asOf: today }).catch(() => []);
    if (deadlines.length > 0) hasData = true;
    const late = deadlines.filter((d) => d.status === 'overdue');
    const toPay = deadlines.filter((d) => d.kind === 'payable_due' && d.status !== 'upcoming');
    const toCollect = deadlines.filter((d) => d.kind === 'receivable_due' && d.status === 'overdue');
    push({
      id: 'late',
      href: `/${locale}/deadlines`,
      label: t('late'),
      value: late.length,
      hint: t('lateHint'),
      tone: late.length > 0 ? 'late' : 'paid',
    });
    push({
      id: 'collect',
      href: `/${locale}/deadlines`,
      label: t('collect'),
      value: <Money centimes={toCollect.reduce((s, d) => s + (d.amountCentimes ?? 0), 0)} />,
      hint: t('collectHint'),
      tone: toCollect.length > 0 ? 'late' : 'neutral',
    });
    push({
      id: 'pay',
      href: `/${locale}/deadlines`,
      label: t('pay'),
      value: <Money centimes={toPay.reduce((s, d) => s + (d.amountCentimes ?? 0), 0)} />,
      hint: t('payHint'),
      tone: toPay.length > 0 ? 'due' : 'neutral',
    });
  }
  return { tiles, hasData };
}

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
