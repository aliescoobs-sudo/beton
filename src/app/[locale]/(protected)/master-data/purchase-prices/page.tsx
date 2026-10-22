import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { businessDateOf } from '@/modules/clock';
import {
  componentCostPerM3For,
  listComponents,
  listPurchasePrices,
  listPurchaseUnits,
  listSelectableConcreteTypes,
  listSuppliers,
} from '@/modules/master-data';
import { PurchasePricesManager } from '@/modules/master-data/ui/purchase-prices/purchase-prices-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

export default async function PurchasePricesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'purchase_prices.read');
  const pool = getPool('app');
  const businessDate = businessDateOf((await getRequestClock()).now());
  const [components, units, prices, suppliers] = await Promise.all([
    listComponents(pool, user),
    listPurchaseUnits(pool, user),
    listPurchasePrices(pool, user),
    listSuppliers(pool, user),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const unitLabel = new Map(units.map((u) => [u.id, u.label]));

  // The derived cost is a margin figure: owner and partner only.
  let costs = null;
  if (can(user.role, 'margins.read')) {
    const types = await listSelectableConcreteTypes(pool, user);
    costs = await Promise.all(
      types.map(async (type) => {
        const cost = await componentCostPerM3For(pool, user, type.id, businessDate);
        return { code: type.code, label: type.label, costCentimes: cost.ok ? cost.value : null };
      }),
    );
  }

  const t = await getTranslations('masterData.purchasePrices');
  return (
    <div>
      <PageHeader title={t('title')} />
      <PurchasePricesManager
        components={components
          .filter((c) => c.status === 'active')
          .map((c) => ({
            id: c.id,
            nameFr: c.nameFr,
            nameAr: c.nameAr,
            baseUnit: c.baseUnit,
            units: units
              .filter((u) => u.componentId === c.id && u.status === 'active')
              .map((u) => ({ id: u.id, label: u.label, factorToBase: u.factorToBase })),
            history: prices
              .filter((p) => p.componentId === c.id)
              .map((p) => ({
                id: p.id,
                supplierName: supplierName.get(p.supplierId) ?? '—',
                unitLabel: unitLabel.get(p.purchaseUnitId) ?? '—',
                priceHtCentimes: p.priceHtCentimes,
                effectiveFrom: p.effectiveFrom,
              })),
          }))}
        suppliers={suppliers.filter((s) => s.status === 'active').map((s) => ({ id: s.id, name: s.name }))}
        costs={costs}
        businessDate={businessDate}
        editable={can(user.role, 'purchase_prices.write')}
      />
    </div>
  );
}
