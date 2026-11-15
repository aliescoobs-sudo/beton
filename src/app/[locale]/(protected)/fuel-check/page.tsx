import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { formatMl, listPlants } from '@/modules/master-data';
import { loadFuelCheck } from '@/modules/operations';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

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
  const assumed = rows.some((r) => r.thresholdIsAssumption);
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {assumed && (
        <p role="status" className="form-band mb-4 font-semibold" data-testid="fuel-check-assumed">
          {t('assumedThreshold')}
        </p>
      )}
      <form
        method="get"
        className="form-band mb-4 flex flex-wrap items-end gap-3"
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
        <button type="submit" className="btn btn-primary" data-testid="fuel-check-apply">
          {t('apply')}
        </button>
      </form>
      {!res.ok && (
        <p role="alert" className="field-error">
          {t('invalid')}
        </p>
      )}
      {res.ok && rows.length === 0 && <EmptyState title={t('none')} />}
      {rows.length > 0 && (
        <Table data-testid="fuel-check-table">
          <thead>
            <tr>
              <Th>{t('month')}</Th>
              <Th>{t('truck')}</Th>
              <Th>{t('basis')}</Th>
              <Th numeric>{t('units')}</Th>
              <Th numeric>{t('expected')}</Th>
              <Th numeric>{t('measured')}</Th>
              <Th numeric>{t('variance')}</Th>
              <Th numeric>{t('variancePct')}</Th>
              <Th numeric>{t('threshold')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
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
      )}
    </div>
  );
}
