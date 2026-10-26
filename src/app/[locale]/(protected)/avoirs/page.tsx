import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listAvoirCandidates, listAvoirs } from '@/modules/ledger';
import { IssueAvoir } from '@/modules/ledger/ui/avoirs/issue-avoir';
import { formatM3 } from '@/modules/operations/ui/format';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, Table, Td, Th } from '@/ui';
import { issueAvoirAction } from './actions';

/**
 * Avoirs: concrete refused or brought back after it was billed stays billed until the owner credits it (DECISIONS 93). The
 * loads waiting for their avoir, and the avoirs issued with the invoice, the BL and the loss record they reference. Owner issues
 * (a fresh second factor), support reads.
 */
export default async function AvoirsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'avoirs.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:avoirs');
  const [candidates, avoirs] = await Promise.all([listAvoirCandidates(pool, user), listAvoirs(pool, user)]);
  const canIssue = can(user.role, 'avoirs.issue');
  const t = await getTranslations('ledger.avoirs');
  const tPdf = await getTranslations('ledger.pdf');
  const tLoss = await getTranslations('operations.loss');
  return (
    <div className="space-y-10">
      <PageHeader title={t('title')} description={t('intro')} />
      <section aria-labelledby="avoir-todo">
        <h2 id="avoir-todo" className="mb-3 text-xl">
          {t('toCredit')}
        </h2>
        {candidates.length === 0 ? (
          <EmptyState title={t('noneToCredit')} data-testid="avoirs-none-to-credit" />
        ) : (
          <Table data-testid="avoir-candidates">
            <thead>
              <tr>
                <Th>{t('bl')}</Th>
                <Th>{t('invoice')}</Th>
                <Th>{t('client')}</Th>
                <Th numeric>{t('lost')}</Th>
                <Th>{t('lossReason')}</Th>
                <Th numeric>{t('amountTtc')}</Th>
                {canIssue && <Th>{t('action')}</Th>}
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.deliveryId} data-testid={`avoir-todo-${c.blNo}`}>
                  <Td>
                    <a href={`/${locale}/deliveries/${c.deliveryId}`} className="underline">
                      <bdi dir="ltr">{c.blNo}</bdi>
                    </a>
                  </Td>
                  <Td>
                    <a href={`/${locale}/invoices/${c.invoiceId}`} className="underline">
                      <bdi dir="ltr">{c.invoiceNumber}</bdi>
                    </a>
                  </Td>
                  <Td>{c.clientName}</Td>
                  <Td numeric>{formatM3(c.lostL)} m³</Td>
                  <Td>{tLoss(`reasons.${c.lossReason}` as never)}</Td>
                  <Td numeric>
                    <Money centimes={c.amountTtcCentimes} />
                  </Td>
                  {canIssue && (
                    <Td>
                      <IssueAvoir deliveryId={c.deliveryId} blNo={c.blNo} issue={issueAvoirAction} />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="avoir-issued">
        <h2 id="avoir-issued" className="mb-3 text-xl">
          {t('issued')}
        </h2>
        {avoirs.length === 0 ? (
          <EmptyState title={t('noneIssued')} data-testid="avoirs-none" />
        ) : (
          <Table data-testid="avoir-list">
            <thead>
              <tr>
                <Th>{t('number')}</Th>
                <Th>{t('date')}</Th>
                <Th>{t('invoice')}</Th>
                <Th>{t('bl')}</Th>
                <Th>{t('client')}</Th>
                <Th numeric>{t('lost')}</Th>
                <Th numeric>{t('totalHt')}</Th>
                <Th numeric>{t('totalTtc')}</Th>
                <Th>{t('reason')}</Th>
              </tr>
            </thead>
            <tbody>
              {avoirs.map((a) => (
                <tr key={a.id} data-testid={`avoir-${a.number}`}>
                  <Td>
                    <bdi dir="ltr">{a.number}</bdi>{' '}
                    <a
                      href={`/${locale}/avoirs/${a.id}/pdf`}
                      className="underline"
                      data-testid={`avoir-pdf-${a.number}`}
                    >
                      {tPdf('short')}
                    </a>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{a.avoirDate}</bdi>
                  </Td>
                  <Td>
                    <a href={`/${locale}/invoices/${a.invoiceId}`} className="underline">
                      <bdi dir="ltr">{a.invoiceNumber}</bdi>
                    </a>
                  </Td>
                  <Td>
                    <a href={`/${locale}/deliveries/${a.deliveryId}`} className="underline">
                      <bdi dir="ltr">{a.blNo}</bdi>
                    </a>
                  </Td>
                  <Td>{a.clientName}</Td>
                  <Td numeric>{formatM3(a.volumeL)} m³</Td>
                  <Td numeric>
                    <Money centimes={a.totalHtCentimes} />
                  </Td>
                  <Td numeric>
                    <Money centimes={a.totalTtcCentimes} />
                  </Td>
                  <Td>{a.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
