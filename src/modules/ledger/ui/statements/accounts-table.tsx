import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Money, StatusPill, Table, Th } from '@/ui';
import type { AccountRow } from '../../service/statement-service';

/** The "Comptes" list: who owes what, what is late, the next due date. Each row opens the statement. */
export function AccountsTable({ rows, locale }: { rows: AccountRow[]; locale: string }) {
  const t = useTranslations('ledger.statements');
  return (
    <div className="mt-6 space-y-8">
      {(['client', 'supplier'] as const).map((kind) => {
        const part = rows.filter((r) => r.kind === kind);
        return (
          <section key={kind} data-testid={`accounts-${kind}`}>
            <h2 className="mb-2 text-xl">{t(kind === 'client' ? 'clients' : 'suppliers')}</h2>
            <Table>
              <thead>
                <tr>
                  <Th>{t('party')}</Th>
                  <Th numeric>{t(kind === 'client' ? 'owesUs' : 'weOwe')}</Th>
                  <Th numeric>{t('late')}</Th>
                  <Th>{t('nextDue')}</Th>
                  <Th>{t('flags')}</Th>
                </tr>
              </thead>
              <tbody>
                {part.map((r) => (
                  <tr key={r.partyId} data-testid={`account-row-${r.name}`}>
                    <td className="font-medium">
                      <Link
                        href={`/${locale}/statements/${kind}/${r.partyId}`}
                        className="underline"
                        data-testid="account-open"
                      >
                        <bdi dir="ltr" className="num">
                          {r.code}
                        </bdi>{' '}
                        — <bdi>{r.name}</bdi>
                      </Link>
                    </td>
                    <td className="is-num">
                      <Money centimes={r.balanceCentimes} />
                    </td>
                    <td className="is-num">
                      {r.lateCentimes > 0 ? <Money centimes={r.lateCentimes} /> : '—'}
                    </td>
                    <td>{r.nextDueDate ? <bdi dir="ltr">{r.nextDueDate}</bdi> : '—'}</td>
                    <td>
                      {r.hasDispute && <StatusPill status="late">{t('dispute')}</StatusPill>}
                      {r.lateCentimes > 0 && (
                        <StatusPill status="late" className="ms-1">
                          {t('lateFlag')}
                        </StatusPill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
        );
      })}
    </div>
  );
}
