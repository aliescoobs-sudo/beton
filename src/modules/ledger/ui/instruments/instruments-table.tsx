import { useTranslations } from 'next-intl';
import { Money, StatusPill, Table, Th, type PillStatus } from '@/ui';
import type { InstrumentState } from '../../domain/instrument';
import type { InstrumentView } from '../../service/instrument-service';

export type InstrumentRow = InstrumentView & {
  daysLeft: number | null;
  deadline: string | null;
  earlyEvent: boolean;
};

const PILL: Record<InstrumentState, PillStatus> = {
  received: 'due',
  deposited: 'due',
  issued: 'due',
  cleared: 'paid',
  bounced: 'late',
  regularized: 'paid',
  disputed: 'late',
  cancelled: 'cancelled',
};

/** Read-only list. Row actions (deposit, clear, bounce, ...) are added by the lifecycle task through `actions`. */
export function InstrumentsTable({
  rows,
  actions,
}: {
  rows: InstrumentRow[];
  today: string;
  actions?: (row: InstrumentRow) => React.ReactNode;
}) {
  const t = useTranslations('ledger.instruments');
  const tPay = useTranslations('ledger.payments');
  if (rows.length === 0) {
    return (
      <p className="mt-6 text-sm text-muted" data-testid="instruments-empty">
        {t('empty')}
      </p>
    );
  }
  return (
    <div className="mt-6">
      <Table>
        <thead>
          <tr>
            <Th>{t('direction')}</Th>
            <Th>{t('method')}</Th>
            <Th>{t('party')}</Th>
            <Th>{t('number')}</Th>
            <Th>{t('writtenDate')}</Th>
            <Th numeric>{t('amount')}</Th>
            <Th>{t('state')}</Th>
            {actions && <Th>{t('actions')}</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`instrument-${r.number ?? r.id}`} data-state={r.state}>
              <td>{t(r.direction === 'in' ? 'incoming' : 'outgoing')}</td>
              <td>{tPay(`methods.${r.method}`)}</td>
              <td>
                <bdi>{r.partyName}</bdi>
                {r.clientDisputed && (
                  <StatusPill status="late" className="ms-2" data-testid="instrument-client-disputed">
                    {t('clientDisputed')}
                  </StatusPill>
                )}
              </td>
              <td>{r.number ? <bdi dir="ltr">{r.number}</bdi> : '—'}</td>
              <td>
                {r.writtenDate ? <bdi dir="ltr">{r.writtenDate}</bdi> : '—'}
                {r.postDated && (
                  <StatusPill status="neutral" className="ms-2" data-testid="instrument-postdated">
                    {t('postDated')}
                  </StatusPill>
                )}
              </td>
              <td className="is-num">
                <Money centimes={r.amountCentimes} />
              </td>
              <td>
                <StatusPill status={PILL[r.state]} data-testid="instrument-state">
                  {t(`states.${r.state}`)}
                </StatusPill>
                <bdi dir="ltr" className="ms-2 text-sm text-muted">
                  {r.stateDate}
                </bdi>
                {r.earlyEvent && (
                  <StatusPill status="neutral" className="ms-2" data-testid="instrument-early">
                    {t('early')}
                  </StatusPill>
                )}
                {r.daysLeft !== null && (
                  <span className="ms-2 text-sm" data-testid="instrument-countdown">
                    {r.daysLeft > 0
                      ? t('daysLeft', { count: r.daysLeft })
                      : r.daysLeft === 0
                        ? t('lastDay')
                        : t('windowClosed')}
                  </span>
                )}
              </td>
              {actions && <td>{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
