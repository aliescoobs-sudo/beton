import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { RelatedDocuments } from '@/modules/ledger/ui/related/related-documents';
import { getCompanyProfile, getInvoiceDocument, getRelatedDocuments, legalMentions } from '@/modules/ledger';
import { PrintInvoiceButton } from '@/modules/ledger/ui/invoices/print-button';
import { formatM3 } from '@/modules/operations/ui/format';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Money, PageHeader, Table, Td, Th } from '@/ui';
import { printInvoiceAction } from './actions';

/**
 * The invoice (or credit note) as a printable document: our legal mentions, the client and its ICE, the lines, HT, VAT, TTC and
 * the payment term of law 69-21. Every figure is read from the stored rows. The browser prints it (or saves it as a PDF).
 */
export default async function InvoiceDocumentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'invoices.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:invoice');
  const related = await getRelatedDocuments(pool, user, { kind: 'invoice', id: id });
  const doc = await getInvoiceDocument(pool, user, id);
  if (!doc) notFound();
  const company = await getCompanyProfile(pool, user, { today: (await getRequestClock()).today() });
  const { invoice: i } = doc;
  const credit = i.creditNoteOf !== null;
  const t = await getTranslations('ledger.invoiceDocument');
  const tInvoices = await getTranslations('ledger.invoices');
  const tPdf = await getTranslations('ledger.pdf');
  return (
    <div>
      <PageHeader
        title={
          <>
            {credit ? t('creditNote') : t('invoice')} <bdi dir="ltr">{i.number}</bdi>
          </>
        }
        actions={
          <span className="no-print flex gap-2">
            <PrintInvoiceButton invoiceId={id} audit={printInvoiceAction} />
            <a
              href={`/${locale}/invoices/${id}/pdf`}
              className="btn btn-secondary btn-sm"
              data-testid="pdf-download"
            >
              {tPdf('download')}
            </a>
          </span>
        }
      />
      <article className="card document max-w-4xl space-y-6 p-6" data-testid="invoice-document">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="text-sm" data-testid="invoice-company">
            {company ? (
              legalMentions(company).map((line) => (
                <p key={line}>
                  <bdi dir="ltr">{line}</bdi>
                </p>
              ))
            ) : (
              <p className="text-muted">{t('noCompany')}</p>
            )}
          </div>
          <div data-testid="invoice-client">
            <p className="field-label">{t('billedTo')}</p>
            <p className="font-bold">{i.clientName}</p>
            {i.clientIce && (
              <p>
                <bdi dir="ltr">ICE {i.clientIce}</bdi>
              </p>
            )}
          </div>
        </div>
        <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <div>
            <dt className="field-label">{t('number')}</dt>
            <dd>
              <bdi dir="ltr">{i.number}</bdi>
              {doc.creditNoteOfNumber && (
                <span>
                  {' '}
                  — {t('creditsInvoice')} <bdi dir="ltr">{doc.creditNoteOfNumber}</bdi>
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('order')}</dt>
            <dd>
              <bdi dir="ltr">{i.orderCodes.join(', ')}</bdi>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('date')}</dt>
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
          {i.paymentState && (
            <div className="print:hidden" data-testid="invoice-payment-state">
              <dt className="field-label">{tInvoices('state')}</dt>
              <dd>
                {tInvoices(`payment.${i.paymentState}`)}
                {i.paymentState === 'partial' && (
                  <>
                    {' '}
                    (<Money centimes={i.paidCentimes} />)
                  </>
                )}
              </dd>
            </div>
          )}
        </dl>
        {credit && i.reason && (
          <p data-testid="invoice-reason">
            {t('reason')} : {i.reason}
          </p>
        )}
        <Table data-testid="invoice-lines">
          <thead>
            <tr>
              <Th>{t('description')}</Th>
              <Th numeric>{t('volume')}</Th>
              <Th numeric>{t('unitPrice')}</Th>
              <Th numeric>{t('lineTotal')}</Th>
            </tr>
          </thead>
          <tbody>
            {doc.groups.map((g) => (
              <tr key={`${g.typeCode}-${g.unitPriceHtCentimes}`} data-testid={`invoice-group-${g.typeCode}`}>
                <Td>
                  <bdi dir="ltr">
                    {g.typeCode} · {g.typeLabel}
                  </bdi>
                  <br />
                  <span className="text-sm text-muted">
                    {t('blNumbers')} :{' '}
                    <bdi dir="ltr" data-testid="invoice-group-bls">
                      {g.blNos.join(', ')}
                    </bdi>
                  </span>
                </Td>
                <Td numeric>{formatM3(g.volumeL)} m³</Td>
                <Td numeric>
                  <Money centimes={g.unitPriceHtCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={g.amountHtCentimes} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <dl
          className="ms-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1"
          data-testid="invoice-totals"
        >
          <dt>{t('totalHt')}</dt>
          <dd className="text-end">
            <Money centimes={i.totalHtCentimes} />
          </dd>
          <dt>
            {t('vat')} ({i.vatRateBp / 100} %)
          </dt>
          <dd className="text-end">
            <Money centimes={i.totalVatCentimes} />
          </dd>
          <dt className="font-bold">{t('totalTtc')}</dt>
          <dd className="text-end font-bold">
            <Money centimes={i.totalTtcCentimes} />
          </dd>
          {doc.advanceCentimes > 0 && (
            <>
              <dt data-testid="invoice-advance-label">{t('advanceReceived')}</dt>
              <dd className="text-end" data-testid="invoice-advance">
                − <Money centimes={doc.advanceCentimes} />
              </dd>
              <dt className="font-bold">{t('netToPay')}</dt>
              <dd className="text-end font-bold" data-testid="invoice-net">
                <Money centimes={doc.netToPayCentimes} />
              </dd>
            </>
          )}
        </dl>
        <p className="text-sm" data-testid="invoice-terms">
          {t('terms', { days: doc.termDays })}
        </p>
      </article>
      <RelatedDocuments items={related} locale={locale} className="mt-8" />
    </div>
  );
}
