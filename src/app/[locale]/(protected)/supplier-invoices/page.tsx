import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listSupplierInvoices } from '@/modules/ledger';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** The supplier invoices: our code and the supplier's, the order they are for, dates and amounts, and where each stands. Owner and support. */
export default async function SupplierInvoicesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'supplier_invoices.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:supplier-invoices');
  const invoices = await listSupplierInvoices(pool, user);
  const t = await getTranslations('ledger.supplierInvoices');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {invoices.length === 0 ? (
        <EmptyState title={t('none')} data-testid="si-none" />
      ) : (
        <Table data-testid="si-list">
          <thead>
            <tr>
              <Th>{t('code')}</Th>
              <Th>{t('supplierNo')}</Th>
              <Th>{t('supplier')}</Th>
              <Th>{t('purchase')}</Th>
              <Th>{t('invoiceDate')}</Th>
              <Th>{t('dueDate')}</Th>
              <Th numeric>{t('totalTtc')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} data-testid={`si-${i.code}`}>
                <Td>
                  <a
                    href={`/${locale}/supplier-invoices/${i.id}`}
                    className="underline"
                    data-testid={`si-open-${i.code}`}
                  >
                    <bdi dir="ltr">{i.code}</bdi>
                  </a>
                </Td>
                <Td>
                  <bdi dir="ltr">{i.supplierInvoiceNo}</bdi>
                </Td>
                <Td>{i.supplierName}</Td>
                <Td>
                  <a href={`/${locale}/purchases/${i.purchaseId}`} className="underline">
                    <bdi dir="ltr">{i.purchaseCode}</bdi>
                  </a>
                </Td>
                <Td>
                  <bdi dir="ltr">{i.invoiceDate}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{i.dueDate}</bdi>
                </Td>
                <Td numeric>
                  <Money centimes={i.totalTtcCentimes} />
                </Td>
                <Td>
                  <StatusPill
                    status={i.state === 'approved' ? 'paid' : i.state === 'rejected' ? 'cancelled' : 'due'}
                    data-testid={`si-state-${i.code}`}
                  >
                    {t(`states.${i.state}`)}
                  </StatusPill>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
