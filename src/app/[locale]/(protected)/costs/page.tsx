import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatCentimes } from '@/lib/money';
import { getPool } from '@/lib/db/pools';
import { formatMl, loadCostScreen } from '@/modules/master-data';
import { CostForms } from '@/modules/master-data/ui/cost-forms';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import {
  replaceCostRateAction,
  replaceFuelNormAction,
  replacePriceGridAction,
  replacePurchaseTransportAction,
} from './actions';

/** Cost data (owner, app_admin): the rates, the fuel norms, the delivered transport and the selling price grid. A replacement is a new row; an assumed value is labelled "assumption". */
export default async function CostsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'costs.manage');
  const t = await getTranslations('costs');
  const data = await loadCostScreen(getPool('app'), user);
  const assumed =
    data.rates.filter((r) => r.isAssumption).length +
    data.fuel.filter((r) => r.isAssumption).length +
    data.grid.filter((r) => r.isAssumption).length +
    data.transports.filter((r) => r.transportIsAssumption).length;
  const pill = (isAssumption: boolean | null) =>
    isAssumption === null ? (
      <StatusPill status="due">{t('notRecorded')}</StatusPill>
    ) : (
      <StatusPill status={isAssumption ? 'due' : 'paid'}>
        {t(isAssumption ? 'assumption' : 'real')}
      </StatusPill>
    );
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {assumed > 0 && (
        <p role="status" className="form-band mb-4 font-semibold" data-testid="costs-assumed">
          {t('banner', { count: assumed })}
        </p>
      )}

      <h2 className="mt-4 text-lg font-semibold">{t('rates.title')}</h2>
      {data.rates.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <Table data-testid="costs-rates">
          <thead>
            <tr>
              <Th>{t('rates.key')}</Th>
              <Th>{t('value')}</Th>
              <Th>{t('from')}</Th>
              <Th>{t('plant')}</Th>
              <Th>{t('status')}</Th>
              <Th>{t('source')}</Th>
            </tr>
          </thead>
          <tbody>
            {data.rates.map((r) => (
              <tr key={r.id}>
                <Td>{t(`rates.keys.${r.key}` as never)}</Td>
                <Td>
                  <bdi dir="ltr">
                    {formatCentimes(r.valueCentimes)} {t(`units.${r.unit}` as never)}
                  </bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{r.effectiveFrom}</bdi>
                </Td>
                <Td>{r.plantCode ?? t('allPlants')}</Td>
                <Td>{pill(r.isAssumption)}</Td>
                <Td>{r.sourceNote}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 className="mt-6 text-lg font-semibold">{t('fuel.title')}</h2>
      {data.fuel.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <Table data-testid="costs-fuel">
          <thead>
            <tr>
              <Th>{t('fuel.scope')}</Th>
              <Th>{t('fuel.perTrip')}</Th>
              <Th>{t('fuel.perHour')}</Th>
              <Th>{t('fuel.perKm')}</Th>
              <Th>{t('from')}</Th>
              <Th>{t('status')}</Th>
            </tr>
          </thead>
          <tbody>
            {data.fuel.map((r) => (
              <tr key={r.id}>
                <Td>{r.truckCode ?? t(`kinds.${r.truckKind}` as never)}</Td>
                <Td>
                  <bdi dir="ltr">{r.perTripMl === null ? '—' : formatMl(r.perTripMl)}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{r.perHourMl === null ? '—' : formatMl(r.perHourMl)}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{r.perKmMl === null ? '—' : formatMl(r.perKmMl)}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{r.effectiveFrom}</bdi>
                </Td>
                <Td>{pill(r.isAssumption)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 className="mt-6 text-lg font-semibold">{t('transport.title')}</h2>
      {data.transports.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <Table data-testid="costs-transport">
          <thead>
            <tr>
              <Th>{t('transport.component')}</Th>
              <Th>{t('transport.price')}</Th>
              <Th>{t('from')}</Th>
              <Th>{t('transport.transport')}</Th>
              <Th>{t('status')}</Th>
            </tr>
          </thead>
          <tbody>
            {data.transports.map((r) => (
              <tr key={r.priceId}>
                <Td>
                  <bdi dir="ltr">{r.componentCode}</bdi> {r.componentName}
                </Td>
                <Td>
                  <bdi dir="ltr">
                    {formatCentimes(r.priceCentimes)} / {r.unitLabel}
                  </bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{r.effectiveFrom}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">
                    {r.transportCentimes === null ? '—' : formatCentimes(r.transportCentimes)}
                  </bdi>
                </Td>
                <Td>{pill(r.transportIsAssumption)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 className="mt-6 text-lg font-semibold">{t('grid.title')}</h2>
      {data.grid.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <Table data-testid="costs-grid">
          <thead>
            <tr>
              <Th>{t('grid.class')}</Th>
              <Th>{t('grid.method')}</Th>
              <Th>{t('grid.price')}</Th>
              <Th>{t('from')}</Th>
              <Th>{t('status')}</Th>
            </tr>
          </thead>
          <tbody>
            {data.grid.map((r) => (
              <tr key={r.id}>
                <Td>
                  <bdi dir="ltr">{r.classCode}</bdi>
                </Td>
                <Td>{t(`methods.${r.method}` as never)}</Td>
                <Td>
                  <bdi dir="ltr">{formatCentimes(r.priceCentimes)}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{r.effectiveFrom}</bdi>
                </Td>
                <Td>{pill(r.isAssumption)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <CostForms
        classes={data.classes}
        trucks={data.trucks}
        transports={data.transports.map((r) => ({
          id: r.priceId,
          label: `${r.componentCode} ${r.componentName} (${r.effectiveFrom})`,
        }))}
        replaceRate={replaceCostRateAction}
        replaceFuel={replaceFuelNormAction}
        replaceTransport={replacePurchaseTransportAction}
        replaceGrid={replacePriceGridAction}
      />
    </div>
  );
}
