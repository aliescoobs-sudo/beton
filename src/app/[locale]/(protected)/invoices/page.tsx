import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listInvoices } from '@/modules/ledger';
import { CancelInvoice } from '@/modules/ledger/ui/invoices/cancel-invoice';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { cancelInvoiceAction } from './actions';

/** Invoices and credit notes: number, order, client, ICE, dates with the issue deadline of law 69-21, amounts. Owner and support. */
export default async function InvoicesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'invoices.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:invoices');
  const [invoices, clock] = await Promise.all([listInvoices(pool, user), getRequestClock()]);
  const today = clock.today();
  const t = await getTranslations('ledger.invoices');
  const canCancel = can(user.role, 'ledger.reverse');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {invoices.length === 0 ? (
        <EmptyState title={t('none')} data-testid="invoices-none" />
      ) : (
        <Table data-testid="invoices-list">
          <thead>
            <tr>
              <Th>{t('number')}</Th>
              <Th>{t('order')}</Th>
              <Th>{t('client')}</Th>
              <Th>{t('invoiceDate')}</Th>
              <Th>{t('issueDeadline')}</Th>
              <Th>{t('dueDate')}</Th>
              <Th numeric>{t('totalHt')}</Th>
              <Th numeric>{t('totalVat')}</Th>
              <Th numeric>{t('totalTtc')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} data-testid={`invoice-${i.number}`}>
                <Td>
                  <bdi dir="ltr">{i.number}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{i.orderCode}</bdi>
                </Td>
                <Td>
                  {i.clientName}
                  {i.clientIce && (
                    <>
                      <br />
                      <bdi dir="ltr" className="text-sm text-muted">
                        ICE {i.clientIce}
                      </bdi>
                    </>
                  )}
                </Td>
                <Td>
                  <bdi dir="ltr">{i.invoiceDate}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{i.issueDeadline}</bdi>
                  {!i.creditNoteOf && i.invoiceDate > i.issueDeadline && (
                    <StatusPill status="late">{t('issuedLate')}</StatusPill>
                  )}
                </Td>
                <Td>
                  <bdi dir="ltr">{i.dueDate}</bdi>
                  {!i.creditNoteOf && !i.cancelled && i.dueDate < today && (
                    <StatusPill status="late">{t('overdue')}</StatusPill>
                  )}
                </Td>
                <Td numeric>
                  <Money centimes={i.totalHtCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={i.totalVatCentimes} />{' '}
                  <span className="text-sm text-muted">({i.vatRateBp / 100} %)</span>
                </Td>
                <Td numeric>
                  <Money centimes={i.totalTtcCentimes} />
                </Td>
                <Td>
                  {i.creditNoteOf ? (
                    <StatusPill status="cancelled">{t('creditNote')}</StatusPill>
                  ) : i.cancelled ? (
                    <StatusPill status="cancelled">{t('cancelled')}</StatusPill>
                  ) : canCancel ? (
                    <CancelInvoice invoiceId={i.id} number={i.number} cancel={cancelInvoiceAction} />
                  ) : (
                    <StatusPill status="ontrack">{t('issued')}</StatusPill>
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
