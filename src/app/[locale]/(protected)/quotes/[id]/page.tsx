import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getCompanyProfile, getQuote, legalMentions, quoteIsOpen } from '@/modules/ledger';
import { PrintQuoteButton } from '@/modules/ledger/ui/quotes/print-button';
import { formatM3 } from '@/modules/operations/ui/format';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { buttonClass, Money, PageHeader, Table, Td, Th } from '@/ui';
import { printQuoteAction } from './actions';

/** A quote as a printable document, with the way to turn it into an order (a human saves the prefilled order form). */
export default async function QuoteDocumentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'quotes.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:quote');
  const quote = await getQuote(pool, user, id);
  if (!quote) notFound();
  const today = (await getRequestClock()).today();
  const company = await getCompanyProfile(pool, user, { today });
  const t = await getTranslations('ledger.quotes');
  const canConvert = can(user.role, 'orders.write') && quoteIsOpen(quote, today);
  return (
    <div>
      <PageHeader
        title={
          <>
            {t('document')} <bdi dir="ltr">{quote.code}</bdi>
          </>
        }
        actions={
          <span className="no-print flex gap-2">
            <PrintQuoteButton quoteId={id} audit={printQuoteAction} />
            {canConvert && (
              <a
                href={`/${locale}/orders/new?quote=${id}`}
                className={buttonClass('primary')}
                data-testid="quote-convert"
              >
                {t('convert')}
              </a>
            )}
          </span>
        }
      />
      <article className="card max-w-4xl space-y-6 p-6" data-testid="quote-document">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="text-sm">
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
          <div>
            <p className="field-label">{t('quotedTo')}</p>
            <p className="font-bold">{quote.clientName}</p>
            {quote.clientIce && (
              <p>
                <bdi dir="ltr">ICE {quote.clientIce}</bdi>
              </p>
            )}
          </div>
        </div>
        <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <div>
            <dt className="field-label">{t('date')}</dt>
            <dd>
              <bdi dir="ltr">{quote.quoteDate}</bdi>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('validUntil')}</dt>
            <dd>
              <bdi dir="ltr">{quote.validUntil}</bdi>
            </dd>
          </div>
        </dl>
        <Table>
          <thead>
            <tr>
              <Th>{t('designation')}</Th>
              <Th numeric>{t('volumeShort')}</Th>
              <Th numeric>{t('unitPrice')}</Th>
              <Th numeric>{t('totalHt')}</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>
                {quote.typeLabel} (<bdi dir="ltr">{quote.typeCode}</bdi>)
              </Td>
              <Td numeric>{formatM3(quote.volumeL)} m³</Td>
              <Td numeric>
                <Money centimes={quote.unitPriceHtCentimes} />
              </Td>
              <Td numeric>
                <Money centimes={quote.totalHtCentimes} />
              </Td>
            </tr>
          </tbody>
        </Table>
        <dl className="ms-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          <dt>{t('totalHt')}</dt>
          <dd className="text-end">
            <Money centimes={quote.totalHtCentimes} />
          </dd>
          <dt>
            {t('vat')} ({quote.vatRateBp / 100} %)
          </dt>
          <dd className="text-end">
            <Money centimes={quote.totalVatCentimes} />
          </dd>
          <dt className="font-bold">{t('totalTtc')}</dt>
          <dd className="text-end font-bold" data-testid="quote-ttc">
            <Money centimes={quote.totalTtcCentimes} />
          </dd>
        </dl>
        {quote.convertedOrderCode && (
          <p data-testid="quote-converted">
            {t('convertedTo')} <bdi dir="ltr">{quote.convertedOrderCode}</bdi>
          </p>
        )}
      </article>
    </div>
  );
}
