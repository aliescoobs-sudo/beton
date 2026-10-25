import { getTranslations } from 'next-intl/server';
import { negateCentimes } from '@/lib/money';
import type { ForecastDay } from '@/modules/rules-engine';
import { Money } from '@/ui';
import { formatDay, moneyText } from './format';

const W = 100; // one column is 100 units wide in the drawing; the page scales it
const H = 200;
const PAD = 14;

/**
 * The forecast as in the design: cash above the zero line, deficit below it, the safety threshold, the worst case as a dashed
 * line, and under each day the flows that land on it. Everything is drawn from the engine's figures: this component only
 * scales them to pixels. Deficit bars are hatched and labelled, so colour is never the only signal. The drawing is an image
 * with a text summary; the day columns under it are the readable, tappable detail (a list per day).
 */
export async function ForecastChart({
  days,
  threshold,
  locale,
  lowest,
}: {
  days: ForecastDay[];
  threshold: number;
  locale: string;
  lowest: { date: string; balance: number } | null;
}) {
  const t = await getTranslations('dashboard');
  const n = days.length;
  if (n === 0) return null;
  const values = days.flatMap((d) => [d.base, d.worst]);
  const top = Math.max(0, threshold, ...values);
  const bottom = Math.min(0, threshold, ...values);
  const span = Math.max(1, top - bottom);
  const y = (v: number) => PAD + ((top - v) / span) * (H - 2 * PAD);
  const zero = y(0);
  const firstDeficit = days.find((d) => d.base < threshold);
  const summary = firstDeficit
    ? t('forecast.summaryDeficit', {
        date: formatDay(firstDeficit.date, locale),
        balance: moneyText(firstDeficit.base),
      })
    : t('forecast.summaryOk');
  const label = t('forecast.chartLabel', {
    from: formatDay(days[0]!.date, locale),
    to: formatDay(days.at(-1)!.date, locale),
    summary,
  });
  const worstPath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${i * W + W / 2},${y(d.worst)}`).join(' ');
  const basePath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${i * W + W / 2},${y(d.base)}`).join(' ');

  return (
    <figure className="space-y-3" data-testid="forecast-chart">
      <figcaption className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-2">
          <svg width="14" height="14" aria-hidden="true">
            <rect width="14" height="14" fill="var(--color-ok)" />
          </svg>
          {t('forecast.above')}
        </span>
        <span className="inline-flex items-center gap-2">
          <svg width="14" height="14" aria-hidden="true">
            <rect width="14" height="14" fill="url(#hatch-key)" stroke="var(--color-status-late)" />
            <defs>
              <pattern
                id="hatch-key"
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="5" height="5" fill="var(--color-surface)" />
                <rect width="2" height="5" fill="var(--color-status-late)" />
              </pattern>
            </defs>
          </svg>
          {t('forecast.below')}
        </span>
        <span className="inline-flex items-center gap-2">
          <svg width="22" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="22"
              y2="4"
              stroke="var(--color-ink)"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          {t('forecast.worst')}
        </span>
        {threshold !== 0 && (
          <span className="inline-flex items-center gap-2">
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" stroke="var(--color-amber)" strokeWidth="2" />
            </svg>
            {t('forecast.threshold')}
          </span>
        )}
      </figcaption>
      {lowest && (
        <p className="text-sm font-semibold" data-testid="forecast-lowest">
          {lowest.balance < threshold ? (
            <>
              {t('forecast.lowest', {
                date: formatDay(lowest.date, locale),
                balance: moneyText(lowest.balance),
              })}
            </>
          ) : (
            t('forecast.noLow')
          )}
        </p>
      )}

      <div className="relative max-w-full overflow-x-auto" dir="ltr">
        <div className={n > 8 ? 'min-w-[1380px]' : 'min-w-[736px]'}>
          <svg
            viewBox={`0 0 ${n * W} ${H}`}
            preserveAspectRatio="none"
            className="block h-56 w-full bg-surface"
            role="img"
            aria-label={label}
          >
            <defs>
              <pattern
                id="hatch"
                width="9"
                height="9"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="9" height="9" fill="var(--color-surface)" />
                <rect width="4" height="9" fill="var(--color-status-late)" />
              </pattern>
            </defs>
            {days.map((d, i) => {
              const bad = d.base < threshold;
              const barTop = Math.min(y(d.base), zero);
              const barH = Math.max(1, Math.abs(y(d.base) - zero));
              return (
                <g key={d.date}>
                  {bad && (
                    <rect
                      x={i * W}
                      y={0}
                      width={W}
                      height={H}
                      fill="var(--color-status-late)"
                      opacity="0.07"
                    />
                  )}
                  <rect
                    x={i * W + W * 0.25}
                    y={barTop}
                    width={W * 0.5}
                    height={barH}
                    fill={d.base >= 0 ? 'var(--color-ok)' : 'url(#hatch)'}
                    stroke={d.base >= 0 ? 'none' : 'var(--color-status-late)'}
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    data-testid={`bar-${d.date}`}
                    data-balance={d.base}
                  />
                </g>
              );
            })}
            <line
              x1="0"
              x2={n * W}
              y1={zero}
              y2={zero}
              stroke="var(--color-ink)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
            {threshold !== 0 && (
              <line
                x1="0"
                x2={n * W}
                y1={y(threshold)}
                y2={y(threshold)}
                stroke="var(--color-amber)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <path
              d={basePath}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth="1"
              opacity="0.35"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={worstPath}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth="2"
              strokeDasharray="6 5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <ol
            className={`grid ${n > 8 ? 'grid-cols-[repeat(15,minmax(0,1fr))]' : 'grid-cols-[repeat(8,minmax(0,1fr))]'}`}
            data-testid="forecast-days"
          >
            {days.map((d, i) => {
              const bad = d.base < threshold;
              return (
                <li
                  key={d.date}
                  className={`border-s border-rule px-1.5 py-2 text-xs ${bad ? 'bg-[color-mix(in_srgb,var(--color-status-late)_8%,transparent)]' : ''}`}
                  data-testid={`day-${d.date}`}
                  data-deficit={bad ? 'true' : 'false'}
                  dir={locale === 'ar' ? 'rtl' : 'ltr'}
                >
                  <p className="font-semibold">
                    {i === 0 ? t('forecast.dayToday') : formatDay(d.date, locale)}
                  </p>
                  <p className={`mt-1 font-semibold ${bad ? 'text-status-late' : ''}`}>
                    <span aria-hidden="true">{bad ? '▼ ' : '▲ '}</span>
                    <span className="sr-only">{bad ? t('forecast.deficit') : t('forecast.ok')}: </span>
                    <Money centimes={d.base} />
                  </p>
                  {d.worst !== d.base && (
                    <p className="mt-0.5 text-muted">
                      {t('forecast.worstBalance')}: <Money centimes={d.worst} />
                    </p>
                  )}
                  <ul className="mt-2 space-y-1.5">
                    {d.events.length === 0 && d.worstOnlyEvents.length === 0 && (
                      <li className="text-muted">{t('forecast.noEvents')}</li>
                    )}
                    {d.events.map((e) => (
                      <li key={e.flowId} className="leading-snug" data-testid={`event-${e.flowId}`}>
                        <span aria-hidden="true">{e.direction === 'in' ? '↑' : '↓'}</span>{' '}
                        <Money
                          centimes={e.direction === 'in' ? e.amount : negateCentimes(e.amount)}
                          className="font-semibold"
                        />
                        <span className="block text-muted">
                          <bdi>{e.code}</bdi> · <bdi>{e.partyName}</bdi>
                        </span>
                        <span className="block text-muted">{t(`forecast.certainty.${e.certainty}`)}</span>
                        {e.earlyPresentable && (
                          <span className="block font-semibold">{t('forecast.early')}</span>
                        )}
                        {e.onDate !== d.date && (
                          <span className="block text-muted">{t('forecast.dayOff')}</span>
                        )}
                      </li>
                    ))}
                    {d.worstOnlyEvents.map((e) => (
                      <li key={`w-${e.flowId}`} className="leading-snug text-muted">
                        <span aria-hidden="true">⇢ ↓</span> <Money centimes={negateCentimes(e.amount)} />
                        <span className="block">
                          <bdi>{e.code}</bdi> · {t('forecast.worstOnly')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <p className="text-xs text-muted">{t('forecast.notCounted')}</p>
    </figure>
  );
}
