import { getTranslations } from 'next-intl/server';
import {
  type AlertView,
  type CashOption,
  type DashboardView,
  draftOfCollect,
  draftsOfCashOption,
  draftsOfStockOption,
  type InformationalOption,
  type OptionsResult,
  SEVERITIES,
  type StockOption,
} from '@/modules/rules-engine';
import { Card, Money } from '@/ui';
import { alertText, cashOptionLines, collectLine, kindsText, stockOptionLines, type T } from './describe';
import { renderDrafts } from './drafts-text';
import { formatBp, formatDate, formatDay, moneyText } from './format';
import { type ApplyInput, type ApplyResult, OptionActions } from './option-actions';
import { ReclassifyForm, type ReclassifyResult } from './reclassify-form';
import { SeverityTag } from './severity';

export interface ReportActions {
  apply: (input: ApplyInput) => Promise<ApplyResult>;
  reclassify: (input: { alertKey: string; severity: string; reason: string }) => Promise<ReclassifyResult>;
}

/**
 * The alert report (SPEC-owner-dashboard §2.2): what is wrong and since when, the causes, the options ranked with their
 * computed coverage and the forecast each would give, and the actions. Options only propose: confirming one asks for a
 * fresh second factor and writes a decision (and, for an early deposit, the deposit itself); nothing is sent.
 */
export async function AlertReport({
  view,
  alert,
  locale,
  banks,
  actions,
}: {
  view: DashboardView;
  alert: AlertView;
  locale: string;
  banks: { id: string; label: string }[];
  actions: ReportActions;
}) {
  const t = (await getTranslations('dashboard')) as unknown as T;
  const tr = await getTranslations('dashboard');
  const options = view.options[alert.key];
  const cash = options?.cash ?? null;
  const children = view.alerts.filter((a) => alert.childKeys.includes(a.key));
  const decisions = view.decisions[alert.key] ?? [];

  const cashCard = (o: CashOption, rank: number | null, result: OptionsResult) => {
    const draftPreview = renderDrafts(t, locale, draftsOfCashOption(o));
    const id = `opt-${rank ?? 'x'}`;
    const idx = (date: string) => result.dates.indexOf(date);
    return (
      <Card
        key={o.id}
        data-testid={`option-${rank ?? 'other'}`}
        data-option-id={o.id}
        data-full={o.full ? 'true' : 'false'}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg">
            {rank !== null && <span className="me-2 text-muted">{tr('option.rank', { rank })}</span>}
            {kindsText(t, o.kind)}
          </h3>
          <p className="font-semibold" data-testid={`${id}-coverage`}>
            {tr('option.coverage', { percent: formatBp(o.coverageBp) })}{' '}
            <span className="text-sm font-normal text-muted">
              ({o.full ? tr('option.full') : tr('option.partial')})
            </span>
          </p>
        </div>
        <ul className="mt-2 list-disc ps-5 text-sm">
          {cashOptionLines(t, locale, o).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <ul className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid={`${id}-figures`}>
          <li>
            {tr('option.gain', { amount: moneyText(o.gain), date: formatDay(result.targetDate, locale) })}
          </li>
          <li>
            {tr('option.after', {
              date: formatDay(result.targetDate, locale),
              balance: moneyText(o.newBalance),
            })}
          </li>
          {o.full && o.surplus > 0 && <li>{tr('option.surplus', { amount: moneyText(o.surplus) })}</li>}
          {o.cost > 0 && <li>{tr('option.cost', { amount: moneyText(o.cost) })}</li>}
          {o.lowestAfter && (
            <li>
              {tr('option.lowestAfter', {
                date: formatDay(o.lowestAfter.date, locale),
                balance: moneyText(o.lowestAfter.balance),
              })}
            </li>
          )}
          <li>{tr('option.counterparties', { count: o.counterparties.length })}</li>
        </ul>
        <ul className="mt-2 space-y-1 text-sm font-semibold">
          {o.createsNewRisk && (
            <li>
              ▲{' '}
              {tr('option.newRisk', { dates: o.newDeficitDates.map((d) => formatDay(d, locale)).join(', ') })}
            </li>
          )}
          {o.remainingDeficitDates.length > 0 && (
            <li>
              ◆{' '}
              {tr('option.remaining', {
                dates: o.remainingDeficitDates
                  .slice(0, 3)
                  .map((d) => formatDay(d, locale))
                  .join(', '),
              })}
            </li>
          )}
          {!o.createsNewRisk && o.remainingDeficitDates.length === 0 && <li>● {tr('option.clean')}</li>}
          {o.presentsPostDated && <li>◆ {tr('option.postDated')}</li>}
        </ul>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold">{tr('report.forecastAfter')}</summary>
          <table className="mt-2 w-full text-xs" data-testid={`${id}-whatif`}>
            <thead>
              <tr>
                <th className="text-start">{tr('report.dayColumn')}</th>
                <th className="text-end">{tr('report.forecastBefore')}</th>
                <th className="text-end">{tr('report.forecastAfter')}</th>
              </tr>
            </thead>
            <tbody>
              {result.dates.map((d) => (
                <tr key={d} className={d === result.targetDate ? 'font-semibold' : ''}>
                  <td>{formatDay(d, locale)}</td>
                  <td className="text-end">
                    <Money centimes={result.baselineSeries[idx(d)] ?? 0} />
                  </td>
                  <td className="text-end">
                    <Money centimes={o.series[idx(d)] ?? 0} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        {view.canDecide ? (
          <div className="mt-4">
            <OptionActions
              alertKey={alert.key}
              optionId={o.id}
              expectedGain={o.gain}
              banks={o.apply?.type === 'deposit-instruments' ? banks : null}
              draftPreview={draftPreview}
              presentsPostDated={o.presentsPostDated}
              apply={actions.apply}
              locale={locale}
              testId={id}
            />
          </div>
        ) : null}
      </Card>
    );
  };

  const stockCard = (o: StockOption, idx: number) => (
    <Card key={o.id} data-testid={`stock-option-${idx}`} data-option-id={o.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg">{tr(`option.kinds.${o.kind}`)}</h3>
        <p className="font-semibold">{tr('option.stock.coverage', { percent: formatBp(o.coverageBp) })}</p>
      </div>
      <ul className="mt-2 list-disc ps-5 text-sm">
        {stockOptionLines(t, locale, o).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <ul className="mt-2 space-y-1 text-sm font-semibold">
        {o.arrivesOn && (
          <li>
            {o.inTime
              ? `● ${tr('option.stock.inTime', { date: formatDay(o.arrivesOn, locale) })}`
              : `▲ ${tr('option.stock.late', { date: formatDay(o.arrivesOn, locale), shortage: formatDay(alert.targetDate, locale) })}`}
          </li>
        )}
        {o.split?.shortageAfter && (
          <li>◆ {tr('option.stock.shortageMoves', { date: formatDay(o.split.shortageAfter, locale) })}</li>
        )}
        {o.draft && o.cashImpact === null && <li>◆ {tr('option.stock.noPrice')}</li>}
      </ul>
      {view.canDecide && (
        <div className="mt-4">
          <OptionActions
            alertKey={alert.key}
            optionId={o.id}
            banks={null}
            draftPreview={renderDrafts(t, locale, draftsOfStockOption(o))}
            presentsPostDated={false}
            apply={actions.apply}
            locale={locale}
            testId={`stock-opt-${idx}`}
          />
        </div>
      )}
    </Card>
  );

  const collectCard = (o: InformationalOption, idx: number) => (
    <Card key={o.id} data-testid={`collect-${idx}`} data-option-id={o.id}>
      <h3 className="text-lg">{tr('option.kinds.COLLECT-OVERDUE')}</h3>
      <p className="mt-2 text-sm">{collectLine(t, o)}</p>
      {view.canDecide && (
        <div className="mt-4">
          <OptionActions
            alertKey={alert.key}
            optionId={o.id}
            banks={null}
            draftPreview={renderDrafts(t, locale, [draftOfCollect(o)])}
            presentsPostDated={false}
            apply={actions.apply}
            locale={locale}
            testId={`collect-opt-${idx}`}
          />
        </div>
      )}
    </Card>
  );

  const hasOptions =
    (cash?.ranked.length ?? 0) > 0 ||
    (options?.stock.length ?? 0) > 0 ||
    options?.collect != null ||
    (cash?.informational.length ?? 0) > 0;

  return (
    <div className="space-y-8" data-testid="alert-report" data-alert={alert.key}>
      <section className="space-y-2">
        <SeverityTag severity={alert.severity} label={tr(`severity.${alert.severity}`)} />
        <p className="text-lg font-semibold">{alertText(t, locale, alert)}</p>
        <p className="text-sm text-muted" data-testid="report-first">
          {tr('report.first')}: {formatDate(alert.firstDetectedOn)} ·{' '}
          {alert.daysAhead > 0 ? tr('alerts.ahead', { count: alert.daysAhead }) : tr('alerts.sameDay')}
        </p>
        {alert.override && (
          <p className="text-sm font-semibold">
            {tr('alerts.overridden', {
              severity: tr(`severity.${alert.severity}`),
              computed: tr(`severity.${alert.computedSeverity}`),
            })}{' '}
            · {alert.override.reason}
          </p>
        )}
      </section>

      {children.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl">{tr('report.children')}</h2>
          <ul>
            {children.map((c) => (
              <li key={c.key} className="row-item text-sm">
                {alertText(t, locale, c)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {alert.causes.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl">{tr('report.causes')}</h2>
          <ol className="list-decimal ps-5 text-sm" data-testid="report-causes">
            {alert.causes.map((c) => (
              <li key={c.flowId}>
                <Money centimes={c.amount} className="font-semibold" /> · <bdi>{c.code}</bdi> ·{' '}
                <bdi>{c.partyName}</bdi>
                {c.earlyPresentable && <span className="font-semibold"> · {tr('forecast.early')}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <h2 className="mb-1 text-xl">{tr('report.options')}</h2>
        {cash && (
          <p className="mb-3 text-sm text-muted">{tr('report.considered', { count: cash.considered })}</p>
        )}
        {!hasOptions && <p className="text-sm text-muted">{tr('report.noOptions')}</p>}
        <div className="space-y-4">
          {cash?.ranked.map((o, i) => cashCard(o, i + 1, cash))}
          {options?.stock.map((o, i) => stockCard(o, i + 1))}
        </div>
        {cash && cash.others.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-semibold">{tr('report.otherOptions')}</summary>
            <div className="mt-3 space-y-4">{cash.others.map((o) => cashCard(o, null, cash))}</div>
          </details>
        )}
        {((cash?.informational.length ?? 0) > 0 || options?.collect) && (
          <div className="mt-6 space-y-3">
            <h3 className="text-sm">{tr('report.informational')}</h3>
            {(options?.collect ? [options.collect] : (cash?.informational ?? []))
              .slice(0, 5)
              .map((o, i) => collectCard(o, i + 1))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xl">{tr('report.decisionsTitle')}</h2>
        {decisions.length === 0 ? (
          <p className="text-sm text-muted">{tr('report.noDecisions')}</p>
        ) : (
          <ul data-testid="report-decisions">
            {decisions.map((d) => (
              <li key={d.id} className="row-item space-y-1 text-sm">
                <p className="font-semibold">
                  {kindsText(t, d.kinds)} · {tr('option.decided', { date: formatDate(d.decidedOn) })}
                </p>
                {d.draftText && <pre className="whitespace-pre-wrap text-muted">{d.draftText}</pre>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.canDecide ? (
        <section>
          <ReclassifyForm
            alertKey={alert.key}
            options={SEVERITIES.filter((s) => s !== alert.computedSeverity).map((s) => ({
              value: s,
              label: tr(`severity.${s}`),
            }))}
            reclassify={actions.reclassify}
          />
        </section>
      ) : (
        <p className="text-sm text-muted">{tr('report.readOnly')}</p>
      )}
    </div>
  );
}
