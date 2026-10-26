import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getSupplierInvoice } from '@/modules/ledger';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** One supplier invoice: its lines as the supplier wrote them, the order and the receipts it is linked to, and its events. Owner and support. */
export default async function SupplierInvoicePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'supplier_invoices.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:supplier-invoice');
  const detail = await getSupplierInvoice(pool, user, id);
  if (!detail) notFound();
  const { invoice: i } = detail;
  const t = await getTranslations('ledger.supplierInvoices');
  return (
    <div className="space-y-8">
      <PageHeader
        title={
          <>
            {t('title1')} <bdi dir="ltr">{i.code}</bdi>
          </>
        }
        description={t('detailIntro')}
      />
      <article className="card max-w-4xl space-y-6 p-6" data-testid="si-document">
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="field-label">{t('supplier')}</dt>
            <dd>{i.supplierName}</dd>
          </div>
          <div>
            <dt className="field-label">{t('supplierNo')}</dt>
            <dd>
              <bdi dir="ltr">{i.supplierInvoiceNo}</bdi>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('purchase')}</dt>
            <dd>
              <a
                href={`/${locale}/purchases/${i.purchaseId}`}
                className="underline"
                data-testid="si-purchase-link"
              >
                <bdi dir="ltr">{i.purchaseCode}</bdi>
              </a>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('state')}</dt>
            <dd>
              <StatusPill
                status={i.state === 'approved' ? 'paid' : i.state === 'rejected' ? 'cancelled' : 'due'}
              >
                {t(`states.${i.state}`)}
              </StatusPill>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('invoiceDate')}</dt>
            <dd>
              <bdi dir="ltr">{i.invoiceDate}</bdi>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('dueDate')}</dt>
            <dd>
              <bdi dir="ltr">{i.dueDate}</bdi>
            </dd>
          </div>
        </dl>
        <Table data-testid="si-lines">
          <thead>
            <tr>
              <Th>{t('description')}</Th>
              <Th>{t('orderLine')}</Th>
              <Th numeric>{t('qty')}</Th>
              <Th numeric>{t('unitPrice')}</Th>
              <Th numeric>{t('lineTotal')}</Th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((l) => (
              <tr key={l.seq}>
                <Td>{l.description}</Td>
                <Td>
                  {l.purchaseLineSeq === null ? t('notOnOrder') : <bdi dir="ltr">#{l.purchaseLineSeq}</bdi>}
                </Td>
                <Td numeric>{(l.qtyMilli / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 })}</Td>
                <Td numeric>
                  <Money centimes={l.unitPriceHtCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={l.lineHtCentimes} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <dl className="ms-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1" data-testid="si-totals">
          <dt>{t('totalHt')}</dt>
          <dd className="text-end">
            <Money centimes={i.totalHtCentimes} />
          </dd>
          <dt>{t('vat')}</dt>
          <dd className="text-end">
            <Money centimes={i.totalVatCentimes} />
          </dd>
          <dt className="font-bold">{t('totalTtc')}</dt>
          <dd className="text-end font-bold">
            <Money centimes={i.totalTtcCentimes} />
          </dd>
        </dl>
      </article>
      <section aria-labelledby="si-receipts">
        <h2 id="si-receipts" className="mb-2 text-xl">
          {t('receipts')}
        </h2>
        {detail.receipts.length === 0 ? (
          <p className="text-sm text-muted" data-testid="si-no-receipts">
            {t('noReceipts')}
          </p>
        ) : (
          <ul data-testid="si-receipts-list">
            {detail.receipts.map((r) => (
              <li key={r.id}>
                {t('receivedOn')} <bdi dir="ltr">{r.receivedDate}</bdi>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="si-events">
        <h2 id="si-events" className="mb-2 text-xl">
          {t('history')}
        </h2>
        <ul data-testid="si-events-list">
          {detail.events.map((e) => (
            <li key={e.seq}>
              <bdi dir="ltr">{e.at.slice(0, 10)}</bdi> · {t(`states.${e.event}`)}
              {e.reason ? ` — ${e.reason}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
