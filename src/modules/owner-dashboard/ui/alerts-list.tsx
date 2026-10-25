import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { type AlertView, type Severity, SEVERITIES } from '@/modules/rules-engine';
import { alertText } from './describe';
import { formatDate } from './format';
import { SeverityTag } from './severity';

const SHOWN = 4;

/**
 * The alerts in the order of SPEC-owner-dashboard §2: the day conflicts first, then each severity, with the day each was
 * first seen and how many days ahead of its date. `hrefOf` null leaves the rows unlinked (the plant's non-money view).
 */
export async function AlertsList({
  alerts,
  locale,
  hrefOf,
  showHistory = true,
}: {
  alerts: AlertView[];
  locale: string;
  hrefOf: ((a: AlertView) => string) | null;
  showHistory?: boolean;
}) {
  const t = await getTranslations('dashboard');
  if (alerts.length === 0)
    return (
      <p className="text-sm text-muted" data-testid="alerts-none">
        {t('alerts.none')}
      </p>
    );
  const conflicts = alerts.filter((a) => a.ruleId === 'DAY-CONFLICT');
  const groups: { id: string; items: AlertView[] }[] = [
    { id: 'conflict', items: conflicts },
    ...SEVERITIES.map((s: Severity) => ({
      id: s,
      items: alerts.filter((a) => a.ruleId !== 'DAY-CONFLICT' && a.severity === s),
    })),
  ].filter((g) => g.items.length > 0);

  const row = (a: AlertView) => {
    const href = hrefOf?.(a);
    const text = alertText(t, locale, a);
    return (
      <li key={a.key} className="row-item" data-testid={`alert-${a.ruleId}`} data-severity={a.severity}>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
          <SeverityTag
            severity={a.severity}
            label={a.ruleId === 'DAY-CONFLICT' ? t('rulesShort.DAY-CONFLICT') : t(`severity.${a.severity}`)}
          />
          <p className="min-w-0 flex-1 basis-64 font-medium">
            {href ? (
              <Link href={href} className="underline decoration-rule underline-offset-4 hover:decoration-ink">
                {text}
              </Link>
            ) : (
              text
            )}
          </p>
        </div>
        <p className="mt-1 text-xs text-muted">
          {t('alerts.target', { date: formatDate(a.targetDate) })}
          {showHistory && (
            <>
              {' · '}
              {t('alerts.detected', { date: formatDate(a.firstDetectedOn) })}
              {' · '}
              {a.daysAhead > 0 ? t('alerts.ahead', { count: a.daysAhead }) : t('alerts.sameDay')}
            </>
          )}
          {a.override && (
            <>
              {' · '}
              {t('alerts.overridden', {
                severity: t(`severity.${a.severity}`),
                computed: t(`severity.${a.computedSeverity}`),
              })}
            </>
          )}
        </p>
      </li>
    );
  };

  return (
    <div className="space-y-6" data-testid="alerts-list" aria-label={t('alerts.listLabel')}>
      {groups.map((g) => (
        <section key={g.id} data-testid={`alerts-${g.id}`}>
          <h3 className="mb-2 flex flex-wrap items-baseline gap-3 text-base">
            {g.id === 'conflict' ? t('rulesShort.DAY-CONFLICT') : t(`severity.${g.id}`)}
            <span className="text-xs font-normal text-muted">
              {g.id === 'conflict' ? '' : `${t(`severityHint.${g.id}` as never)} · `}
              {t('alerts.groupCount', { count: g.items.length })}
            </span>
          </h3>
          <ul>{g.items.slice(0, SHOWN).map(row)}</ul>
          {g.items.length > SHOWN && (
            <details className="mt-1">
              <summary className="cursor-pointer text-sm font-semibold">
                {t('alerts.showMore', { count: g.items.length - SHOWN })}
              </summary>
              <ul>{g.items.slice(SHOWN).map(row)}</ul>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
