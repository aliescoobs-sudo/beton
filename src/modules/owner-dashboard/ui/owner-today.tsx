import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { sumCentimes } from '@/lib/money';
import type { AlertView, DashboardView } from '@/modules/rules-engine';
import { Card, Money } from '@/ui';
import { AlertsList } from './alerts-list';
import { Brief } from './brief';
import { formatDate, formatDay, ltr, m3Text, moneyText } from './format';
import { ExcessConfirm, type ConfirmExcessResult } from './excess-confirm';
import { ForecastChart } from './forecast-chart';
import { SeverityTag } from './severity';
import { StockSummary } from './stock-summary';

const alertHref = (locale: string) => (a: AlertView) => `/${locale}/alerts/${encodeURIComponent(a.key)}`;

/**
 * "Aujourd'hui" for the owner and the support role (money): the brief, the cash position, the forecast with the events of
 * each day, the black day and its causes, the alerts, the stock of the next days, the loads, the late clients and the
 * decisions taken. Every figure is the engine's; with every AI switch off this page is complete (AC-DASH-01).
 */
export async function OwnerToday({
  view,
  locale,
  horizon,
  actions,
}: {
  actions?: { confirmExcess?: (input: { excessId: string; note: string }) => Promise<ConfirmExcessResult> };
  view: DashboardView;
  locale: string;
  horizon: number;
  /** The base horizon of the parameter, to mark the toggle. */
}) {
  const t = await getTranslations('dashboard');
  const overdueTotal = sumCentimes(view.overdue.map((o) => o.amount));
  const decisions = Object.values(view.decisions)
    .flat()
    .sort((a, b) => b.decidedOn.localeCompare(a.decidedOn))
    .slice(0, 5);
  const toggle = (days: number) => (
    <Link
      key={days}
      href={`/${locale}?h=${days}`}
      className={`btn btn-sm ${horizon === days ? 'btn-primary' : 'btn-secondary'}`}
      aria-current={horizon === days ? 'true' : undefined}
      data-testid={`horizon-${days}`}
    >
      {t(days === 7 ? 'forecast.days7' : 'forecast.days14')}
    </Link>
  );

  return (
    <div className="space-y-10" data-testid="owner-today">
      <p className="text-sm text-muted" data-testid="as-of">
        {t('asOf', { date: formatDate(view.today) })} · {t('freshness')}
      </p>

      <section aria-labelledby="sec-brief">
        <h2 id="sec-brief" className="mb-3 text-xl">
          {t('sections.brief')}
        </h2>
        <Brief view={view} locale={locale} />
      </section>

      <section aria-labelledby="sec-cash">
        <h2 id="sec-cash" className="mb-3 text-xl">
          {t('sections.cash')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { id: 'real', value: view.cash.real },
            { id: 'total', value: view.cash.total },
            { id: 'outgoing', value: view.cash.outgoingUncleared },
          ].map((c) => (
            <Card key={c.id} data-testid={`cash-${c.id}`}>
              <p className="field-label">{t(`cash.${c.id}`)}</p>
              <p className="mt-1 text-2xl font-semibold">
                <Money centimes={c.value} />
              </p>
              <p className="mt-1 text-sm text-muted">{t(`cash.${c.id}Hint`)}</p>
            </Card>
          ))}
        </div>
        <p className="mt-3 text-sm">
          <Link href={`/${locale}/cash`} className="font-semibold underline">
            {t('cash.details')}
          </Link>
        </p>
      </section>

      <section aria-labelledby="sec-forecast">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="sec-forecast" className="text-xl">
            {t('sections.forecast')}
          </h2>
          <nav aria-label={t('forecast.horizon')} className="flex items-center gap-2">
            <span className="field-label">{t('forecast.horizon')}</span>
            {toggle(7)}
            {toggle(14)}
          </nav>
        </div>
        <ForecastChart days={view.forecast} threshold={view.threshold} locale={locale} lowest={view.lowest} />
      </section>

      {view.black && (
        <section
          aria-labelledby="sec-black"
          className="border-s-4 border-status-late bg-surface p-4"
          data-testid="black-day"
        >
          <h2 id="sec-black" className="text-xl">
            {t('blackDay.title', { date: formatDay(view.black.date, locale) })}
          </h2>
          <p className="mt-1">
            <SeverityTag
              severity={view.black.severity}
              label={t(view.black.scenario === 'base' ? 'blackDay.scenarioBase' : 'blackDay.scenarioWorst')}
            />
          </p>
          <p className="mt-2 text-lg font-semibold">
            {t('blackDay.shortfall', { amount: moneyText(view.black.shortfall) })}{' '}
            <span className="text-sm font-normal text-muted">
              {t('blackDay.balance', { balance: moneyText(view.black.balance) })}
            </span>
          </p>
          <h3 className="mt-3 text-sm">{t('blackDay.causes')}</h3>
          {view.black.causes.length === 0 ? (
            <p className="text-sm text-muted">{t('blackDay.noCauses')}</p>
          ) : (
            <ol className="mt-1 list-decimal ps-5 text-sm" data-testid="black-causes">
              {view.black.causes.map((c) => (
                <li key={c.flowId}>
                  <Money centimes={c.amount} className="font-semibold" /> · <bdi>{c.code}</bdi> ·{' '}
                  <bdi>{c.partyName}</bdi>
                  {c.earlyPresentable && <span className="font-semibold"> · {t('forecast.early')}</span>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <section aria-labelledby="sec-alerts">
        <h2 id="sec-alerts" className="mb-3 text-xl">
          {t('sections.alerts')}
        </h2>
        <AlertsList alerts={view.alerts} locale={locale} hrefOf={alertHref(locale)} />
      </section>

      <section aria-labelledby="sec-stock">
        <h2 id="sec-stock" className="mb-3 text-xl">
          {t('sections.stock')}
        </h2>
        <StockSummary stock={view.stock} locale={locale} />
      </section>

      <section aria-labelledby="sec-loads">
        <h2 id="sec-loads" className="mb-3 text-xl">
          {t('sections.loads')}
        </h2>
        {view.loads.length === 0 ? (
          <p className="text-sm text-muted">{t('ops.loadsNone')}</p>
        ) : (
          <ul data-testid="loads-list">
            {view.loads.slice(0, 6).map((l) => (
              <li key={l.id} className="row-item text-sm">
                {t('ops.loadLine', {
                  order: ltr(l.code),
                  client: ltr(l.clientCode),
                  type: ltr(l.typeCode),
                  m3: m3Text(l.remainingL),
                  date: formatDate(l.deliveryDate),
                })}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm">
          <Link href={`/${locale}/loads`} className="font-semibold underline">
            {t('sections.loads')}
          </Link>
        </p>
      </section>

      {view.excesses.length > 0 && (
        <section aria-labelledby="sec-excess" data-testid="excess-section">
          <h2 id="sec-excess" className="mb-3 text-xl">
            {t('sections.excess')}
          </h2>
          <ul>
            {view.excesses.map((x) => (
              <li key={x.id} className="row-item text-sm">
                <p>
                  {t('excess.line', {
                    bl: ltr(x.blNo),
                    order: ltr(x.orderCode),
                    client: ltr(x.clientCode),
                    excess: m3Text(x.excessL),
                    loaded: m3Text(x.loadedL),
                    ordered: m3Text(x.orderL),
                  })}{' '}
                  <strong>{t(x.minor ? 'excess.minor' : 'excess.major')}</strong>
                </p>
                {view.canDecide && actions?.confirmExcess && (
                  <ExcessConfirm excessId={x.id} confirm={actions.confirmExcess} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.overdue.length > 0 && (
        <section aria-labelledby="sec-overdue">
          <h2 id="sec-overdue" className="mb-1 text-xl">
            {t('sections.overdue')}
          </h2>
          <p className="mb-2 text-lg font-semibold" data-testid="overdue-total">
            <Money centimes={overdueTotal} />
          </p>
          <p className="text-sm text-muted">{t('forecast.notCounted')}</p>
        </section>
      )}

      {view.invoices.unpaid + view.invoices.partial > 0 && (
        <section aria-labelledby="sec-invoices">
          <h2 id="sec-invoices" className="mb-1 text-xl">
            {t('sections.invoices')}
          </h2>
          <p className="text-lg font-semibold" data-testid="invoices-open">
            <Money centimes={view.invoices.openCentimes} />
          </p>
          <p className="text-sm text-muted">
            {t('invoicesOpen', { unpaid: view.invoices.unpaid, partial: view.invoices.partial })}{' '}
            <Link href={`/${locale}/invoices`} className="font-semibold underline">
              {t('sections.invoices')}
            </Link>
          </p>
        </section>
      )}

      <section aria-labelledby="sec-decisions">
        <h2 id="sec-decisions" className="mb-3 text-xl">
          {t('sections.decisions')}
        </h2>
        {decisions.length === 0 ? (
          <p className="text-sm text-muted">{t('decisions.none')}</p>
        ) : (
          <ul data-testid="decisions-list">
            {decisions.map((d) => (
              <li key={d.id} className="row-item text-sm">
                {t('decisions.line', {
                  kinds: d.kinds.map((k) => t(`option.kinds.${k}`)).join(' + '),
                  date: formatDate(d.decidedOn),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
