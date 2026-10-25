import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { listTrucks } from '@/modules/master-data';
import { getFuelReport, listFuelFills } from '@/modules/operations';
import { FuelFillForm, FuelPurchaseForm } from '@/modules/operations/ui/fuel-forms';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, EmptyState, Input, Money, PageHeader, Table, Td, Th } from '@/ui';
import { recordFuelFillAction, recordFuelPurchaseAction } from './actions';

const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Litres as text with one decimal and a decimal comma ("8,3"). */
const litres = (ml: number): string =>
  (ml / 1000).toLocaleString('fr-FR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  });

/** Fuel per truck: fills, kilometres, litres per 100 km and per m³; the cost per m³ for the owner and support only. */
export default async function FuelPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'fuel.read');
  const query = await searchParams;
  const today = (await getRequestClock()).today();
  const to = query.to && isRealDate(query.to) ? query.to : today;
  const from = query.from && isRealDate(query.from) ? query.from : addDays(to, -29);
  const pool = getPool('app');
  const report = await getFuelReport(pool, user, { from, to });
  const t = await getTranslations('operations.fuel');
  if (!report.ok) return <PageHeader title={t('title')} description={t('errors.INVALID')} />;
  const r = report.value;
  const fills = await listFuelFills(pool, user);
  const canFill = can(user.role, 'fuel.write');
  const canPurchase = can(user.role, 'fuel.purchase');
  const trucks = canFill ? (await listTrucks(pool, user)).filter((k) => k.status === 'active') : [];
  const costOf = (truckId: string) => r.money?.costs.find((c) => c.truckId === truckId);

  return (
    <div className="space-y-10">
      <PageHeader title={t('title')} description={t('intro')} />
      <form method="get" className="flex flex-wrap items-end gap-3" data-testid="fuel-range-form">
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <Input type="date" name="from" defaultValue={from} dir="ltr" data-testid="fuel-from" />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <Input type="date" name="to" defaultValue={to} dir="ltr" data-testid="fuel-to" />
        </label>
        <Button type="submit" variant="secondary">
          {t('show')}
        </Button>
      </form>

      {canFill && (
        <section aria-labelledby="fill-title">
          <h2 id="fill-title" className="mb-3 text-xl">
            {t('fillTitle')}
          </h2>
          <FuelFillForm
            trucks={trucks.map((k) => ({ id: k.id, code: k.code }))}
            today={today}
            record={recordFuelFillAction}
          />
        </section>
      )}

      <section aria-labelledby="trucks-title">
        <h2 id="trucks-title" className="mb-3 text-xl">
          {t('perTruck')}
        </h2>
        {r.trucks.length === 0 ? (
          <EmptyState title={t('none')} data-testid="fuel-none" />
        ) : (
          <Table data-testid="fuel-table">
            <thead>
              <tr>
                <Th>{t('truck')}</Th>
                <Th numeric>{t('fills')}</Th>
                <Th numeric>{t('litresCol')}</Th>
                <Th numeric>{t('km')}</Th>
                <Th numeric>{t('per100')}</Th>
                <Th numeric>{t('delivered')}</Th>
                <Th numeric>{t('perM3')}</Th>
                {r.money && <Th numeric>{t('cost')}</Th>}
                {r.money && <Th numeric>{t('costPerM3')}</Th>}
              </tr>
            </thead>
            <tbody>
              {r.trucks.map((k) => {
                const c = costOf(k.truckId);
                return (
                  <tr key={k.truckId} data-testid={`fuel-${k.truckCode}`}>
                    <Td>
                      <bdi dir="ltr">{k.truckCode}</bdi>
                    </Td>
                    <Td numeric>
                      <bdi dir="ltr">{k.fills}</bdi>
                    </Td>
                    <Td numeric>
                      <bdi dir="ltr">{litres(k.litresMl)} L</bdi>
                    </Td>
                    <Td numeric>{k.km === null ? '—' : <bdi dir="ltr">{k.km} km</bdi>}</Td>
                    <Td numeric>
                      {k.mlPer100Km === null ? '—' : <bdi dir="ltr">{litres(k.mlPer100Km)} L</bdi>}
                    </Td>
                    <Td numeric>
                      <bdi dir="ltr">
                        {(k.deliveredL / 1000).toLocaleString('fr-FR', {
                          maximumFractionDigits: 3,
                          useGrouping: false,
                        })}{' '}
                        m³
                      </bdi>
                    </Td>
                    <Td numeric>{k.mlPerM3 === null ? '—' : <bdi dir="ltr">{litres(k.mlPerM3)} L</bdi>}</Td>
                    {r.money && (
                      <Td numeric>{c?.costCentimes == null ? '—' : <Money centimes={c.costCentimes} />}</Td>
                    )}
                    {r.money && (
                      <Td numeric>
                        {c?.costPerM3Centimes == null ? '—' : <Money centimes={c.costPerM3Centimes} />}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {r.money && (
          <p className="mt-2 text-sm" data-testid="fuel-price">
            {r.money.price.centimesPerLitre === null ? (
              t('noPrice')
            ) : (
              <>
                {t('averagePrice')} <Money centimes={r.money.price.centimesPerLitre} /> / L
              </>
            )}
          </p>
        )}
        <p className="mt-2 text-sm text-muted">{t('note')}</p>
      </section>

      {canPurchase && (
        <section aria-labelledby="purchase-title">
          <h2 id="purchase-title" className="mb-3 text-xl">
            {t('purchaseTitle')}
          </h2>
          <FuelPurchaseForm today={today} record={recordFuelPurchaseAction} />
        </section>
      )}

      <section aria-labelledby="recent-title">
        <h2 id="recent-title" className="mb-3 text-xl">
          {t('recent')}
        </h2>
        {fills.length === 0 ? (
          <p className="text-sm text-muted">{t('none')}</p>
        ) : (
          <ul className="text-sm" data-testid="fuel-recent">
            {fills.map((f) => (
              <li key={f.id} className="row-item">
                <bdi dir="ltr">{f.filledOn}</bdi> · <bdi dir="ltr">{f.truckCode}</bdi> ·{' '}
                <bdi dir="ltr">{litres(f.litresMl)} L</bdi>
                {f.odometerKm !== null && (
                  <>
                    {' · '}
                    <bdi dir="ltr">{f.odometerKm} km</bdi>
                  </>
                )}{' '}
                · {t(`sources.${f.source}` as never)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
