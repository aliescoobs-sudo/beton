import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { type AgingReport, agingSides, getAging } from '@/modules/ledger';
import { listPlants } from '@/modules/master-data';
import { recordMoneyView } from '@/modules/platform-security';
import { requireAnyPagePermission } from '@/modules/platform-security/next';
import { EmptyState, FilterBar, Money, PageHeader, Table, Td, Th } from '@/ui';

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'unknown'] as const;

/**
 * T19c B2 (D245): the aging of clients and of suppliers, by days past due, per party, with the total; filter by plant, link to the statement, CSV export
 * (audited). Each role sees the side it reads (the Responsable clients, the Assistante suppliers, owner and app_admin both). No cost, no margin.
 */
export default async function AgingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requireAnyPagePermission(locale, ['aging.client', 'aging.supplier']);
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:aging');
  const today = (await getRequestClock()).today();
  const plants = await listPlants(pool, user);
  const plantRaw = first(q.plant);
  const plantId = plants.some((p) => p.id === plantRaw) ? plantRaw : null;
  const reports: AgingReport[] = await Promise.all(
    agingSides(user).map((kind) => getAging(pool, user, kind, { today, plantId })),
  );
  const t = await getTranslations('ledger.aging');
  const tl = await getTranslations('list');
  const path = `/${locale}/aging`;
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro', { date: today })} />
      <FilterBar
        label={tl('filters')}
        applyLabel={tl('apply')}
        resetLabel={tl('reset')}
        resetHref={path}
        data-testid="aging-filters"
      >
        <label className="block sm:col-span-2">
          <span className="field-label">{t('plant')}</span>
          <select name="plant" defaultValue={plantId ?? ''} className="input mt-1" data-testid="aging-plant">
            <option value="">{t('allPlants')}</option>
            {plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>
      {plantId && <p className="mt-2 text-sm text-muted">{t('plantNote')}</p>}
      {reports.map((r) => (
        <section
          key={r.kind}
          className="mt-6"
          data-testid={`aging-${r.kind}`}
          aria-labelledby={`aging-h-${r.kind}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`aging-h-${r.kind}`} className="text-lg">
              {t(`side.${r.kind}`)}
            </h2>
            <a
              className="btn btn-secondary btn-sm"
              data-testid={`aging-export-${r.kind}`}
              href={`${path}/export?kind=${r.kind}${plantId ? `&plant=${plantId}` : ''}`}
            >
              {t('export')}
            </a>
          </div>
          {r.parties.length === 0 ? (
            <EmptyState title={t('none')} description={t('noneHint')} />
          ) : (
            <Table data-testid={`aging-table-${r.kind}`}>
              <thead>
                <tr>
                  <Th>{t('party')}</Th>
                  {BUCKETS.map((b) => (
                    <Th key={b} numeric>
                      {t(`bucket.${b}`)}
                    </Th>
                  ))}
                  <Th numeric>{t('total')}</Th>
                </tr>
              </thead>
              <tbody>
                {r.parties.map((p) => (
                  <tr key={p.partyId} data-testid={`aging-row-${p.name}`}>
                    <Td>
                      <Link href={`/${locale}/statements/${r.kind}/${p.partyId}`} className="underline">
                        <bdi dir="ltr">{p.code}</bdi> — <bdi>{p.name}</bdi>
                      </Link>
                    </Td>
                    {BUCKETS.map((b) => (
                      <Td key={b} numeric>
                        {p.aging[b] > 0 ? <Money centimes={p.aging[b]} /> : '—'}
                      </Td>
                    ))}
                    <Td numeric>
                      <Money centimes={p.aging.total} />
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid={`aging-total-${r.kind}`}>
                  <Td>{t('totalRow')}</Td>
                  {BUCKETS.map((b) => (
                    <Td key={b} numeric>
                      <Money centimes={r.total[b]} />
                    </Td>
                  ))}
                  <Td numeric>
                    <Money centimes={r.total.total} />
                  </Td>
                </tr>
              </tfoot>
            </Table>
          )}
        </section>
      ))}
    </div>
  );
}
