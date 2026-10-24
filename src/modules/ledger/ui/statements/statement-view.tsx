import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, Money, StatusPill, type PillStatus, Table, Th } from '@/ui';
import type { LineStatus, Statement, StatementRow } from '../../domain/statement';

const PILL: Record<LineStatus, PillStatus> = {
  booked: 'neutral',
  cancelled: 'cancelled',
  received: 'due',
  deposited: 'due',
  issued: 'due',
  cleared: 'paid',
  bounced: 'late',
  regularized: 'paid',
  disputed: 'late',
};

function Rows({ rows, testId }: { rows: StatementRow[]; testId: string }) {
  const t = useTranslations('ledger.statements');
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted" data-testid={`${testId}-empty`}>
        {t('noLines')}
      </p>
    );
  }
  return (
    <Table data-testid={testId}>
      <thead>
        <tr>
          <Th>{t('date')}</Th>
          <Th>{t('type')}</Th>
          <Th>{t('code')}</Th>
          <Th>{t('status')}</Th>
          <Th numeric>{t('amount')}</Th>
          <Th numeric>{t('balance')}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            data-testid="statement-row"
            data-status={r.status}
            className={r.status === 'cancelled' ? 'opacity-60' : undefined}
          >
            <td>
              <bdi dir="ltr">{r.date}</bdi>
            </td>
            <td>{t(`types.${r.type}`)}</td>
            <td>{r.code ? <bdi dir="ltr">{r.code}</bdi> : '—'}</td>
            <td>
              <StatusPill status={PILL[r.status]}>{t(`statuses.${r.status}`)}</StatusPill>
            </td>
            <td className="is-num">
              <Money centimes={Number(r.amountCentimes)} />
            </td>
            <td className="is-num">
              <Money centimes={Number(r.balanceAfter)} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** One party's statement: the summary, then the commercial and the financial sections with their running balance. */
export function StatementView({
  statement,
  kind,
  exportHref,
  filter,
}: {
  statement: Statement;
  kind: 'client' | 'supplier';
  exportHref: string;
  filter: { from: string; to: string; type: string; status: string };
}) {
  const t = useTranslations('ledger.statements');
  const s = statement.summary;
  const figures = [
    { id: 'balance', label: t(kind === 'client' ? 'owesUs' : 'weOwe'), value: Number(statement.closing) },
    { id: 'ordered', label: t('ordered'), value: Number(s.ordered) },
    { id: 'cancelled', label: t('cancelled'), value: Number(s.cancelled) },
    { id: 'paid', label: t('paid'), value: Number(s.paid) },
    { id: 'pending', label: t('pending'), value: Number(s.pending) },
    { id: 'due', label: t('due'), value: Number(s.due) },
    { id: 'late', label: t('late'), value: Number(s.late) },
  ];
  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {figures.map((f) => (
          <Card key={f.id} data-testid={`summary-${f.id}`}>
            <p className="field-label">{f.label}</p>
            <p className="mt-1 text-xl font-semibold">
              <Money centimes={f.value} />
            </p>
          </Card>
        ))}
      </div>
      <p className="text-sm text-muted">{t('invoicedLater')}</p>

      <form method="get" className="form-band flex flex-wrap items-end gap-3" data-testid="statement-filter">
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <input name="from" type="date" defaultValue={filter.from} dir="ltr" className="input mt-1" />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <input name="to" type="date" defaultValue={filter.to} dir="ltr" className="input mt-1" />
        </label>
        <label className="block">
          <span className="field-label">{t('type')}</span>
          <select name="type" defaultValue={filter.type} className="input mt-1" data-testid="filter-type">
            <option value="">—</option>
            {(['opening', 'order', 'order_cancelled', 'payment'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`types.${x}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('status')}</span>
          <select
            name="status"
            defaultValue={filter.status}
            className="input mt-1"
            data-testid="filter-status"
          >
            <option value="">—</option>
            {(Object.keys(PILL) as LineStatus[]).map((x) => (
              <option key={x} value={x}>
                {t(`statuses.${x}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary btn-sm" data-testid="filter-apply">
          {t('apply')}
        </button>
        <Link
          href={exportHref}
          className="btn btn-secondary btn-sm"
          data-testid="statement-export"
          prefetch={false}
        >
          {t('export')}
        </Link>
      </form>
      {filter.from && (
        <p className="text-sm text-muted" data-testid="carried-in">
          {t('carriedIn')} : <Money centimes={Number(statement.carriedIn)} />
        </p>
      )}

      <section>
        <h2 className="mb-2 text-xl">{t('commercial')}</h2>
        <Rows rows={statement.commercial} testId="section-commercial" />
      </section>
      <section>
        <h2 className="mb-2 text-xl">{t('financial')}</h2>
        <Rows rows={statement.financial} testId="section-financial" />
      </section>
    </div>
  );
}
