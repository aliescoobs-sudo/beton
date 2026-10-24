import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listPurchases } from '@/modules/ledger';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** The purchases: supplier, invoice, due date (law 69-21), total, whether the goods came in. Owner and support (money). */
export default async function PurchasesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'purchases.read_money');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:purchases');
  const [purchases, clock] = await Promise.all([listPurchases(pool, user), getRequestClock()]);
  const today = clock.today();
  const t = await getTranslations('ledger.purchases');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {purchases.length === 0 ? (
        <EmptyState title={t('none')} data-testid="purchases-none" />
      ) : (
        <Table data-testid="purchases-list">
          <thead>
            <tr>
              <Th>{t('code')}</Th>
              <Th>{t('supplier')}</Th>
              <Th>{t('invoiceNo')}</Th>
              <Th>{t('orderDate')}</Th>
              <Th>{t('dueDate')}</Th>
              <Th numeric>{t('totalTtc')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id} data-testid={`purchase-${p.code}`}>
                <Td>
                  <a href={`/${locale}/purchases/${p.id}`} className="underline">
                    <bdi dir="ltr">{p.code}</bdi>
                  </a>
                </Td>
                <Td>{p.supplierName}</Td>
                <Td>
                  <bdi dir="ltr">{p.supplierInvoiceNo ?? '—'}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{p.orderDate}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{p.dueDate}</bdi>
                  {!p.reversed && p.dueDate < today && <StatusPill status="late">{t('overdue')}</StatusPill>}
                </Td>
                <Td numeric>
                  <Money centimes={p.totalTtcCentimes} />
                </Td>
                <Td>
                  {p.reversed ? (
                    <StatusPill status="cancelled">{t('cancelled')}</StatusPill>
                  ) : p.received ? (
                    <StatusPill status="paid">{t('received')}</StatusPill>
                  ) : (
                    <StatusPill status="due">{t('open')}</StatusPill>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
