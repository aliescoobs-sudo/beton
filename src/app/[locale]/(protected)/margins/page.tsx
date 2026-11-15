import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { loadMargins, MARGIN_GROUPS, type MarginBlRow, type MarginSummaryRow } from '@/modules/master-data';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** Basis points as a signed percentage, display only: -1234 → "-12,34 %". */
function bp(v: number | null): string {
  if (v === null) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const frac = String(a % 100).padStart(2, '0');
  return `${sign}${Math.trunc(a / 100)},${frac} %`;
}
const first = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s !== '' ? s : null;
};

/**
 * T17 G9 (SPEC-cost-margin §10, D241): the margins, by month, plant, class, method, client or class × method. Owner and app_admin only (the doors refuse everyone else).
 * No export. Incomplete snapshots are counted and listed apart, never summed with zero costs; the assumption banner stays while any input is assumed.
 */
export default async function MarginsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'bl_margins.read');
  const t = await getTranslations('margins');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:margins');
  const res = await loadMargins(pool, user, {
    group: first(q.group) ?? undefined,
    from: first(q.from),
    to: first(q.to),
    plantId: first(q.plant),
    classId: first(q.class),
    method: first(q.method),
    clientId: first(q.client),
  });
  if (!res.ok)
    return (
      <div>
        <PageHeader title={t('title')} />
        <p role="alert" className="field-error">
          {t('invalid')}
        </p>
      </div>
    );
  const d = res.value;
  const label = (r: MarginSummaryRow) => (r.key === 'NONE' ? t('methodNone') : r.label);
  const neg = (v: number) => (v < 0 ? 'text-red-700' : undefined);
  const marginCells = (m: number, b: number | null) => (
    <>
      <Td numeric>
        <Money centimes={m} className={neg(m)} />
      </Td>
      <Td numeric>
        <bdi dir="ltr" className={neg(m)}>
          {bp(b)}
        </bdi>
      </Td>
    </>
  );
  const blTable = (rows: MarginBlRow[], testId: string, withKeys: boolean) => (
    <Table data-testid={testId}>
      <thead>
        <tr>
          <Th>{t('bl')}</Th>
          <Th>{t('date')}</Th>
          <Th>{t('class')}</Th>
          <Th>{t('method')}</Th>
          <Th>{t('client')}</Th>
          <Th numeric>{t('volume')}</Th>
          <Th numeric>{t('price')}</Th>
          <Th numeric>{t('totalCost')}</Th>
          <Th numeric>M3</Th>
          {withKeys && <Th>{t('missing')}</Th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.snapshotId} data-incomplete={r.incomplete}>
            <Td>
              <bdi dir="ltr">{r.blNo}</bdi>{' '}
              {r.isReversal && <StatusPill status="cancelled">{t('reversal')}</StatusPill>}
            </Td>
            <Td>
              <bdi dir="ltr">{r.loadDate}</bdi>
            </Td>
            <Td>
              <bdi dir="ltr">{r.classCode}</bdi>
            </Td>
            <Td>{r.method ? t(`methods.${r.method as 'GOULOTTE' | 'POMPE'}`) : t('methodNone')}</Td>
            <Td>
              <bdi dir="ltr">{r.clientCode}</bdi> {r.clientName}
            </Td>
            <Td numeric>
              <bdi dir="ltr">{r.volumeL / 1000}</bdi>
            </Td>
            <Td numeric>
              <Money centimes={r.priceCentimes} />
            </Td>
            <Td numeric>
              <Money centimes={r.totalCostCentimes} />
            </Td>
            <Td numeric>
              <Money centimes={r.m3Centimes} className={neg(r.m3Centimes)} />
            </Td>
            {withKeys && (
              <Td>
                <bdi dir="ltr">{r.missingKeys.join(', ')}</bdi>
              </Td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {d.total && d.total.assumedInputs > 0 && (
        <p role="status" className="form-band mb-4 font-semibold" data-testid="margins-assumed">
          {t('banner', { inputs: d.total.assumedInputs, bls: d.total.assumedBlCount })}
        </p>
      )}
      <form method="get" className="form-band mb-4 grid gap-3 sm:grid-cols-4" data-testid="margins-filters">
        <label className="block">
          <span className="field-label">{t('group')}</span>
          <select name="group" defaultValue={d.filters.group} className="input mt-1">
            {MARGIN_GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(`groups.${g}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <input
            type="date"
            name="from"
            dir="ltr"
            defaultValue={d.filters.from ?? ''}
            className="input mt-1"
          />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <input type="date" name="to" dir="ltr" defaultValue={d.filters.to ?? ''} className="input mt-1" />
        </label>
        <label className="block">
          <span className="field-label">{t('plant')}</span>
          <select name="plant" defaultValue={d.filters.plantId ?? ''} className="input mt-1">
            <option value="">—</option>
            {d.plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('class')}</span>
          <select name="class" defaultValue={d.filters.classId ?? ''} className="input mt-1">
            <option value="">—</option>
            {d.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('method')}</span>
          <select name="method" defaultValue={d.filters.method ?? ''} className="input mt-1">
            <option value="">—</option>
            <option value="GOULOTTE">{t('methods.GOULOTTE')}</option>
            <option value="POMPE">{t('methods.POMPE')}</option>
            <option value="NONE">{t('methodNone')}</option>
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('client')}</span>
          <select name="client" defaultValue={d.filters.clientId ?? ''} className="input mt-1">
            <option value="">—</option>
            {d.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn btn-primary" data-testid="margins-apply">
            {t('apply')}
          </button>
        </div>
      </form>

      {d.summary.length === 0 && !d.total?.incompleteCount ? (
        <EmptyState title={t('none')} />
      ) : (
        <Table data-testid="margins-summary">
          <thead>
            <tr>
              <Th>{t(`groups.${d.filters.group}`)}</Th>
              <Th numeric>{t('blCount')}</Th>
              <Th numeric>{t('volume')}</Th>
              <Th numeric>{t('price')}</Th>
              <Th numeric>{t('materials')}</Th>
              <Th numeric>{t('delivery')}</Th>
              <Th numeric>{t('pump')}</Th>
              <Th numeric>{t('plantCost')}</Th>
              <Th numeric>{t('overheads')}</Th>
              <Th numeric>M1</Th>
              <Th numeric>M1 %</Th>
              <Th numeric>M2</Th>
              <Th numeric>M2 %</Th>
              <Th numeric>M3</Th>
              <Th numeric>M3 %</Th>
              <Th numeric>{t('incomplete')}</Th>
            </tr>
          </thead>
          <tbody>
            {[...d.summary, ...(d.total ? [d.total] : [])].map((r) => (
              <tr
                key={r.key}
                data-testid={r.isTotal ? 'margins-total' : `margins-row-${r.key}`}
                className={r.isTotal ? 'font-semibold' : undefined}
              >
                <Td>{r.isTotal ? t('total') : label(r)}</Td>
                <Td numeric>{r.blCount}</Td>
                <Td numeric>
                  <bdi dir="ltr">{r.volumeL / 1000}</bdi>
                </Td>
                <Td numeric>
                  <Money centimes={r.priceCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={r.materialsCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={r.deliveryCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={r.pumpCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={r.plantCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={r.overheadsCentimes} />
                </Td>
                {marginCells(r.m1Centimes, r.m1Bp)}
                {marginCells(r.m2Centimes, r.m2Bp)}
                {marginCells(r.m3Centimes, r.m3Bp)}
                <Td numeric>{r.incompleteCount}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 className="mt-6 text-lg font-semibold">
        {t('incompleteTitle', { count: d.total?.incompleteCount ?? 0 })}
      </h2>
      <p className="text-sm text-muted">{t('incompleteNote')}</p>
      {d.incomplete.length === 0 ? (
        <EmptyState title={t('noneIncomplete')} />
      ) : (
        blTable(d.incomplete, 'margins-incomplete', true)
      )}

      <h2 className="mt-6 text-lg font-semibold">{t('blsTitle')}</h2>
      {d.bls.length === 0 ? <EmptyState title={t('none')} /> : blTable(d.bls, 'margins-bls', false)}
    </div>
  );
}
