import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getEngineParams } from '@/app/engine-params';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { formatDay, qtyText } from '@/modules/owner-dashboard';
import { requirePagePermission } from '@/modules/platform-security/next';
import { can } from '@/modules/platform-security';
import { loadReorder } from '@/modules/rules-engine';
import { EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/** Day by day, what the open orders take from each component against the stock and the receipts expected. Quantities only. */
export default async function StockProjectionPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'stock.read');
  const today = (await getRequestClock()).today();
  const view = await loadReorder(getPool('app'), user, { today, params: await getEngineParams() });
  const t = await getTranslations('dashboard.stockRisk');
  const components = view.risk.components.filter((c) => c.needs > 0 || c.firstShortage || c.firstLow);
  const name = (id: string) => {
    const c = view.risk.components.find((x) => x.componentId === id);
    return c ? (locale === 'ar' ? c.nameAr : c.nameFr) : id;
  };
  const showMoney = can(user.role, 'purchase_prices.read');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {view.risk.missingRecette.length > 0 && (
        <p className="mb-4 font-semibold" data-testid="stock-missing-recette">
          {t('missingRecette', { count: view.risk.missingRecette.length })}
        </p>
      )}
      {view.reorders.length > 0 && (
        <section aria-labelledby="cover-title" className="mb-8" data-testid="cover">
          <h2 id="cover-title" className="mb-1 text-xl">
            {t('coverTitle')}
          </h2>
          <p className="mb-3 text-sm text-muted">{t('coverIntro')}</p>
          <Table>
            <thead>
              <tr>
                <Th>{t('component')}</Th>
                <Th numeric>{t('coverDays')}</Th>
                <Th numeric>{t('lead')}</Th>
                <Th>{t('orderBy')}</Th>
                <Th>{t('action')}</Th>
              </tr>
            </thead>
            <tbody>
              {view.reorders.map((r) => (
                <tr
                  key={r.componentId}
                  data-testid={`cover-${r.componentId}`}
                  data-needs-order={r.needsOrder ? 'true' : 'false'}
                >
                  <Td>{name(r.componentId)}</Td>
                  <Td numeric>
                    {r.coverDays === null ? (
                      t('coverBeyond')
                    ) : (
                      <bdi dir="ltr">{t('days', { count: r.coverDays })}</bdi>
                    )}
                  </Td>
                  <Td numeric>
                    <bdi dir="ltr">{t('days', { count: r.leadDays })}</bdi>
                    <span className="block text-xs text-muted">
                      {r.leadFrom === 'supplier' ? t('leadSupplier') : t('leadParameter')}
                    </span>
                  </Td>
                  <Td>{r.orderBy === null ? '—' : <bdi dir="ltr">{formatDay(r.orderBy, locale)}</bdi>}</Td>
                  <Td>
                    {r.needsOrder ? (
                      <>
                        <StatusPill status={r.late ? 'late' : 'due'}>
                          {r.late ? t('orderLate') : t('toOrder')}
                        </StatusPill>
                        {r.draft ? (
                          <p className="mt-1 text-sm" data-testid={`draft-${r.componentId}`}>
                            {t('draft', {
                              qty: (r.draft.qtyMilli / 1000).toLocaleString('fr-FR', {
                                maximumFractionDigits: 3,
                                useGrouping: false,
                              }),
                              unit: r.draft.unitLabel,
                              supplier: r.draft.supplierName,
                            })}
                            {showMoney && r.draft.estimatedHtCentimes !== null && (
                              <>
                                {' · '}
                                <Money centimes={r.draft.estimatedHtCentimes} />
                              </>
                            )}
                          </p>
                        ) : (
                          <p className="mt-1 text-sm text-muted">{t('draftNone')}</p>
                        )}
                      </>
                    ) : (
                      <StatusPill status="paid">{t('enough')}</StatusPill>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
      {components.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <div className="space-y-8">
          {components.map((c) => (
            <section
              key={c.componentId}
              data-testid={`projection-${c.componentId}`}
              aria-labelledby={`h-${c.componentId}`}
            >
              <h2 id={`h-${c.componentId}`} className="mb-1 text-xl">
                {locale === 'ar' ? c.nameAr : c.nameFr}
              </h2>
              <p className="mb-2 flex flex-wrap items-center gap-3 text-sm">
                {c.firstShortage ? (
                  <StatusPill status="late">
                    <span aria-hidden="true">▲ </span>
                    {t('shortageOn', { date: formatDay(c.firstShortage.date, locale) })}
                  </StatusPill>
                ) : c.firstLow ? (
                  <StatusPill status="due">
                    <span aria-hidden="true">◆ </span>
                    {t('lowOn', { date: formatDay(c.firstLow.date, locale) })}
                  </StatusPill>
                ) : (
                  <StatusPill status="paid">{t('ok')}</StatusPill>
                )}
                {c.maxShortage > 0 && (
                  <span className="font-semibold">
                    {t('missing', { qty: qtyText(c.maxShortage, c.baseUnit) })}
                  </span>
                )}
              </p>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('day')}</Th>
                    <Th numeric>{t('demand')}</Th>
                    <Th numeric>{t('in')}</Th>
                    <Th numeric>{t('levelOn')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {c.days.map((d) => (
                    <tr key={d.date} data-negative={d.level < 0 ? 'true' : 'false'}>
                      <Td>{formatDay(d.date, locale)}</Td>
                      <Td numeric>{d.demand > 0 ? qtyText(d.demand, c.baseUnit) : '—'}</Td>
                      <Td numeric>{d.receipts > 0 ? qtyText(d.receipts, c.baseUnit) : '—'}</Td>
                      <Td numeric>
                        <span className={d.level < 0 ? 'font-semibold text-status-late' : ''}>
                          {d.level < 0 && <span aria-hidden="true">▲ </span>}
                          {qtyText(d.level, c.baseUnit)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
