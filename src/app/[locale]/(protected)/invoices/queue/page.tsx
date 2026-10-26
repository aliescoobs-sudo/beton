import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getInvoiceQueue } from '@/modules/ledger';
import { formatM3 } from '@/modules/operations/ui/format';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { QueueSelection } from '@/modules/ledger/ui/invoices/queue-selection';
import { EmptyState, Money, PageHeader } from '@/ui';
import { createInvoiceAction } from '../actions';

/**
 * Delivered, not invoiced: the loads waiting to be billed, per client. Owner and support also see what each comes to; office
 * sees the BL, the date, the product and the m³, and nothing that is an amount (the answer has no money field).
 */
export default async function InvoiceQueuePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'invoices.queue');
  const pool = getPool('app');
  const withMoney = can(user.role, 'invoices.read');
  const canInvoice = can(user.role, 'invoices.write');
  if (withMoney) await recordMoneyView(pool, user, 'screen:invoice-queue');
  const clients = await getInvoiceQueue(pool, user);
  const t = await getTranslations('ledger.invoiceQueue');
  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} description={t('intro')} />
      {clients.length === 0 ? (
        <EmptyState title={t('none')} data-testid="queue-none" />
      ) : (
        clients.map((c) => (
          <section
            key={c.clientId}
            aria-labelledby={`queue-${c.clientCode}`}
            data-testid={`queue-client-${c.clientCode}`}
          >
            <h2 id={`queue-${c.clientCode}`} className="mb-2 text-xl">
              <bdi dir="ltr">{c.clientCode}</bdi> · {c.clientName}
            </h2>
            <p className="mb-3 text-sm text-muted" data-testid={`queue-summary-${c.clientCode}`}>
              {t('summary', { count: c.deliveries.length })} ·{' '}
              <bdi dir="ltr">{formatM3(c.totalVolumeL)} m³</bdi>
              {c.money && (
                <>
                  {' · '}
                  {t('ttc')} <Money centimes={c.money.ttcCentimes} />
                </>
              )}
            </p>
            <QueueSelection
              clientCode={c.clientCode}
              withAmounts={Boolean(c.money)}
              canInvoice={canInvoice}
              createAction={createInvoiceAction}
              rows={c.deliveries.map((d) => ({
                id: d.deliveryId,
                blNo: d.blNo,
                noteHref: `/${locale}/deliveries/${d.deliveryId}`,
                deliveredOn: d.deliveredAt.slice(0, 10),
                typeCode: d.typeCode,
                typeLabel: d.typeLabel,
                volumeLabel: `${formatM3(d.volumeL)} m³`,
                ...(d.amountHtCentimes !== undefined ? { amountHtCentimes: d.amountHtCentimes } : {}),
              }))}
            />
          </section>
        ))
      )}
    </div>
  );
}
