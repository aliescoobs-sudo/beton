import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { type Deadline, type DeadlineKind, legalDeadlines } from '@/modules/ledger';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

const KINDS: DeadlineKind[] = ['invoice_to_issue', 'receivable_due', 'payable_due'];
const PILL = { overdue: 'late', due_soon: 'due', upcoming: 'ontrack' } as const;

/** The legal dates both ways (law 69-21): invoices to issue by month end, invoices to collect, purchases to pay. Owner and support. */
export default async function DeadlinesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'due_items.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:deadlines');
  const asOf = (await getRequestClock()).today();
  const deadlines = await legalDeadlines(pool, user, { asOf });
  const t = await getTranslations('ledger.deadlines');
  const by = (kind: DeadlineKind): Deadline[] => deadlines.filter((d) => d.kind === kind);
  return (
    <div className="space-y-10">
      <PageHeader title={t('title')} description={t('intro')} />
      {KINDS.map((kind) => (
        <section key={kind} aria-labelledby={`h-${kind}`} data-testid={`deadlines-${kind}`}>
          <h2 id={`h-${kind}`} className="mb-1 text-xl">
            {t(`kinds.${kind}.title`)}
          </h2>
          <p className="mb-3 text-sm text-muted">{t(`kinds.${kind}.hint`)}</p>
          {by(kind).length === 0 ? (
            <EmptyState title={t('none')} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t('date')}</Th>
                  <Th>{t('document')}</Th>
                  <Th>{t('party')}</Th>
                  <Th numeric>{t('amount')}</Th>
                  <Th>{t('state')}</Th>
                </tr>
              </thead>
              <tbody>
                {by(kind).map((d) => (
                  <tr key={`${d.kind}-${d.documentCode}-${d.date}`} data-status={d.status}>
                    <Td>
                      <bdi dir="ltr">{d.date}</bdi>
                    </Td>
                    <Td>
                      <bdi dir="ltr">{d.documentCode}</bdi>
                    </Td>
                    <Td>{d.partyName}</Td>
                    <Td numeric>{d.amountCentimes === null ? '—' : <Money centimes={d.amountCentimes} />}</Td>
                    <Td>
                      <StatusPill status={PILL[d.status]}>{t(`statuses.${d.status}`)}</StatusPill>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      ))}
    </div>
  );
}
