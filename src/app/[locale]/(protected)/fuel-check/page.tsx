import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { formatMl, listPlants } from '@/modules/master-data';
import { loadFuelCheck } from '@/modules/operations';
import { requirePagePermission } from '@/modules/platform-security/next';
import {
  EmptyState,
  FilterBar,
  PageHeader,
  paginate,
  Pagination,
  parseSort,
  SortTh,
  sortRows,
  StatusChips,
  StatusPill,
  Table,
  Td,
  Th,
} from '@/ui';

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
/** Millilitres as litres, signed, display only. */
const litres = (ml: number) => `${ml < 0 ? '-' : ''}${formatMl(Math.abs(ml))}`;
/** Basis points as a signed percentage, display only. */
function pct(bp: number | null): string {
  if (bp === null) return '—';
  const a = Math.abs(bp);
  return `${bp < 0 ? '-' : ''}${Math.trunc(a / 100)},${String(a % 100).padStart(2, '0')} %`;
}

/**
 * T17 G11 (SPEC-cost-margin §8): the fuel actually filled against the norm, per truck and month. Owner and app_admin only. The threshold is a cost rate flagged "assumption" until the owner sets a real one on /costs.
 */
export default async function FuelCheckPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'fuel_check.read');
  const t = await getTranslations('fuelCheck');
  const tl = await getTranslations('list');
  const today = (await getRequestClock()).today();
  const qTo = first(q.to);
  const qFrom = first(q.from);
  const to = qTo && isRealDate(qTo) ? qTo : today;
  const from = qFrom && isRealDate(qFrom) ? qFrom : `${to.slice(0, 7)}-01`;
  const pool = getPool('app');
  const plants = (await listPlants(pool, user)).filter((p) => p.status === 'active');
  const plantId = first(q.plant) || null;
  const res = await loadFuelCheck(pool, user, { from, to, plantId });
  const rows = res.ok ? res.value : [];
  const stateOf = (r: (typeof rows)[number]) => (r.flagged ? 'flagged' : 'other');
  const stateAsked = first(q.state);
  const stateFilter = stateAsked === 'flagged' || stateAsked === 'other' ? stateAsked : '';
  const sort = parseSort(q, ['month', 'truck', 'variance'], { key: 'month', dir: 'desc' });
  const shown = sortRows(
    rows.filter((r) => !stateFilter || stateOf(r) === stateFilter),
    sort,
    { month: (r) => r.month, truck: (r) => r.truckCode, variance: (r) => r.varianceBp },
  );
  const page = paginate(shown, q);
  const path = `/${locale}/fuel-check`;
  const assumed = rows.some((r) => r.thresholdIsAssumption);
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {assumed && (
        <p role="status" className="form-band mb-4 font-semibold" data-testid="fuel-check-assumed">
          {t('assumedThreshold')}
        </p>
      )}
      <FilterBar
        label={tl('filters')}
        applyLabel={t('apply')}
        resetLabel={tl('reset')}
        resetHref={path}
        applyTestId="fuel-check-apply"
        data-testid="fuel-check-filters"
      >
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <input type="date" name="from" dir="ltr" defaultValue={from} className="input mt-1" />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <input type="date" name="to" dir="ltr" defaultValue={to} className="input mt-1" />
        </label>
        <label className="block">
          <span className="field-label">{t('plant')}</span>
          <select name="plant" defaultValue={plantId ?? ''} className="input mt-1">
            <option value="">—</option>
            {plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>
      <StatusChips
        label={tl('status')}
        path={path}
        q={q}
        param="state"
        current={stateFilter}
        chips={[
          { value: '', label: tl('statusAll'), count: rows.length },
          { value: 'flagged', label: t('flagged'), count: rows.filter((r) => r.flagged).length },
          { value: 'other', label: t('ok'), count: rows.filter((r) => !r.flagged).length },
        ]}
      />
      {!res.ok && (
        <p role="alert" className="field-error">
          {t('invalid')}
        </p>
      )}
      {res.ok && rows.length === 0 && <EmptyState title={t('none')} />}
      {rows.length > 0 && shown.length === 0 && (
        <EmptyState title={tl('noMatch')} description={tl('noMatchHint')} />
      )}
      {shown.length > 0 && (
        <>
          <Table data-testid="fuel-check-table">
            <thead>
              <tr>
                <SortTh id="month" sort={sort} path={path} q={q}>
                  {t('month')}
                </SortTh>
                <SortTh id="truck" sort={sort} path={path} q={q}>
                  {t('truck')}
                </SortTh>
                <Th>{t('basis')}</Th>
                <Th numeric>{t('units')}</Th>
                <Th numeric>{t('expected')}</Th>
                <Th numeric>{t('measured')}</Th>
                <Th numeric>{t('variance')}</Th>
                <SortTh id="variance" sort={sort} path={path} q={q} numeric>
                  {t('variancePct')}
                </SortTh>
                <Th numeric>{t('threshold')}</Th>
                <Th>{t('state')}</Th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((r) => (
                <tr key={`${r.month}-${r.truckId}`} data-flagged={r.flagged}>
                  <Td>
                    <bdi dir="ltr">{r.month}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{r.truckCode}</bdi>{' '}
                    <span className="text-muted">{t(`kinds.${r.truckKind}` as never)}</span>
                  </Td>
                  <Td>{t(`bases.${r.basis}`)}</Td>
                  <Td numeric>{r.units}</Td>
                  <Td numeric>
                    <bdi dir="ltr">{r.expectedMl === null ? '—' : litres(r.expectedMl)}</bdi>
                  </Td>
                  <Td numeric>
                    <bdi dir="ltr">{litres(r.measuredMl)}</bdi>
                  </Td>
                  <Td numeric>
                    <bdi dir="ltr">{r.varianceMl === null ? '—' : litres(r.varianceMl)}</bdi>
                  </Td>
                  <Td numeric>
                    <bdi dir="ltr">{pct(r.varianceBp)}</bdi>
                  </Td>
                  <Td numeric>
                    <bdi dir="ltr">{pct(r.thresholdBp)}</bdi>
                  </Td>
                  <Td>
                    {r.flagged ? (
                      <StatusPill status="late">{t('flagged')}</StatusPill>
                    ) : r.noNormUnits > 0 ? (
                      <StatusPill status="due">{t('noNorm', { count: r.noNormUnits })}</StatusPill>
                    ) : r.thresholdBp === null ? (
                      <StatusPill status="due">{t('noThreshold')}</StatusPill>
                    ) : (
                      <StatusPill status="paid">{t('ok')}</StatusPill>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination
            page={page}
            path={path}
            q={q}
            labels={{
              prev: tl('prev'),
              next: tl('next'),
              nav: tl('pageNav'),
              range: tl('range', { from: page.from, to: page.to, total: page.total }),
            }}
          />
        </>
      )}
    </div>
  );
}
