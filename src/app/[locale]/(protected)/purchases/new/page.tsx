import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { PurchaseForm } from '@/modules/ledger/ui/purchases/purchase-form';
import { listComponents, listPlants, listPurchaseUnits, listSuppliers } from '@/modules/master-data';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { createPurchaseAction } from '../actions';

/** Record a purchase: owner and office (office enters it blind and is shown a code, never an amount). */
export default async function NewPurchasePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'purchases.write');
  const pool = getPool('app');
  const [suppliers, components, units, plants] = await Promise.all([
    listSuppliers(pool, user),
    listComponents(pool, user),
    listPurchaseUnits(pool, user),
    listPlants(pool, user),
  ]);
  const t = await getTranslations('ledger.purchases');
  return (
    <div>
      <PageHeader title={t('newTitle')} description={t('newIntro')} />
      <PurchaseForm
        suppliers={suppliers
          .filter((s) => s.status === 'active')
          .map((s) => ({ id: s.id, code: s.code, name: s.name }))}
        components={components
          .filter((c) => c.status === 'active')
          .map((c) => ({
            id: c.id,
            name: locale === 'ar' ? c.nameAr : c.nameFr,
            units: units
              .filter((u) => u.componentId === c.id && u.status === 'active')
              .map((u) => ({ id: u.id, label: u.label })),
          }))}
        plants={
          user.role === 'plant_manager'
            ? []
            : plants.filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name }))
        }
        createAction={createPurchaseAction}
      />
    </div>
  );
}
