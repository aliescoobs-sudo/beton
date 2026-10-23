import type { ReactNode } from 'react';
import type { SimDay } from './sim-days';

/**
 * Permanent band under the top bar while the clock is simulated (SPEC-clock §4): a violet tag, the simulated date, a
 * strip of seven days centred on today, each with weekday and date (past filled grey, today solid ink, future dashed) and the owner's advance control. Presentational:
 * the layout supplies the text and the days.
 */
export function SimBadge({
  label,
  at,
  days = [],
  daysLabel,
  locale = 'fr',
  children,
}: {
  label: string;
  at: string;
  days?: SimDay[];
  daysLabel?: string;
  locale?: string;
  children?: ReactNode;
}) {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  return (
    <div role="status" data-testid="sim-badge" className="border-b border-rule bg-band">
      <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 md:px-8">
        <span className="bg-sim px-2.5 py-0.5 text-sm font-semibold text-white">{label}</span>
        <span className="num text-sm font-medium" dir="ltr">
          {at}
        </span>
        {days.length > 0 && (
          <ol className="flex gap-1" aria-label={daysLabel} data-testid="sim-days">
            {days.map((d) => (
              <li
                key={d.date}
                title={d.date}
                aria-current={d.state === 'today' ? 'date' : undefined}
                className={`sim-day sim-day-${d.state} num`}
                dir="ltr"
              >
                <span className="sim-day-weekday">{weekday.format(new Date(`${d.date}T00:00:00Z`))}</span>
                <span className="sim-day-date">{d.day}</span>
              </li>
            ))}
          </ol>
        )}
        {children}
      </div>
    </div>
  );
}
