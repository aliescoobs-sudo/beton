import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listPlants, listSellingPrices, listSelectableConcreteTypes } from '@/modules/master-data';
import { SellingPricesManager } from '@/modules/master-data/ui/selling-prices/selling-prices-manager';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

export default async function SellingPricesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'selling_prices.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:selling-prices');
  const [types, prices, plants] = await Promise.all([
    listSelectableConcreteTypes(pool, user),
    listSellingPrices(pool, user),
    listPlants(pool, user),
  ]);
  const activePlants = plants.filter((p) => p.status === 'active');
  const t = await getTranslations('masterData.sellingPrices');
  return (
    <div>
      <PageHeader title={t('title')} />
      <SellingPricesManager
        types={types.map((type) => ({
          id: type.id,
          code: type.code,
          label: type.label,
          versions: prices
            .filter((p) => p.concreteTypeId === type.id && p.clientId === null)
            .map((p) => ({
              id: p.id,
              priceHtPerM3Centimes: p.priceHtPerM3Centimes,
              effectiveFrom: p.effectiveFrom,
              plantId: p.plantId,
            })),
        }))}
        plants={activePlants.length > 1 ? activePlants.map((p) => ({ id: p.id, name: p.name })) : []}
        editable={can(user.role, 'selling_prices.write')}
      />
    </div>
  );
}
