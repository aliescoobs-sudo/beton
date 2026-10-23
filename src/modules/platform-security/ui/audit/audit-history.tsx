import { useTranslations } from 'next-intl';
import { auditDiff } from '../../domain/audit-diff';
import type { AuditRow } from '../../service/audit-query';

const show = (value: unknown) =>
  value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);

/**
 * Audit events with their before/after diff. Reusable as the "Historique" tab of any record page: pass the rows from
 * listAuditEvents({ table, … }) — RLS has already scoped them to the viewer.
 */
export function AuditHistory({
  rows,
  names,
  locale,
}: {
  rows: AuditRow[];
  names: Record<string, string>;
  locale: string;
}) {
  const t = useTranslations('history');
  if (rows.length === 0) return <p className="mt-4 text-sm text-muted">{t('empty')}</p>;
  const format = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-MA' : 'fr-MA', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'Africa/Casablanca',
  });
  const who = (row: AuditRow) =>
    row.actorKind === 'system'
      ? t('system')
      : row.actorKind === 'anonymous'
        ? t('anonymous')
        : (names[row.actorUserId] ?? row.actorUserId);

  return (
    <ol className="mt-4 space-y-3" data-testid="audit-history">
      {rows.map((row) => {
        const changes = auditDiff(row.before, row.after);
        return (
          <li key={row.id} className="row-item text-sm" data-testid="audit-event">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>{format.format(row.at)}</span>
              {row.simAt && (
                <span className="text-muted">{t('simulated', { at: format.format(row.simAt) })}</span>
              )}
              <span className="font-medium">{who(row)}</span>
              <span className="flex flex-wrap gap-x-3 font-mono" dir="ltr" data-testid="audit-action">
                <span>{row.action}</span>
                <span>{row.table}</span>
                {row.rowId && <span>{row.rowId}</span>}
              </span>
              {row.reason && <span className="text-muted">{row.reason}</span>}
            </div>
            {row.action === 'update' && changes.length > 0 && (
              <table className="mt-2 w-full text-xs" data-testid="audit-diff">
                <thead>
                  <tr>
                    <th className="text-start font-medium">{t('field')}</th>
                    <th className="text-start font-medium">{t('before')}</th>
                    <th className="text-start font-medium">{t('after')}</th>
                  </tr>
                </thead>
                <tbody dir="ltr">
                  {changes.map((c) => (
                    <tr key={c.field} data-testid={`diff-${c.field}`}>
                      <td className="font-mono">{c.field}</td>
                      <td className="font-mono text-signal">{show(c.before)}</td>
                      <td className="font-mono text-ok">{show(c.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        );
      })}
    </ol>
  );
}
