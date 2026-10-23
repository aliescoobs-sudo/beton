import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { OrderForm } from '@/modules/ledger/ui/orders/order-form';
import {
  listSelectableClients,
  listSelectableConcreteTypes,
  listSiteOptions,
  listZones,
} from '@/modules/master-data';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { createOrderAction, previewOrderAction } from './actions';

export default async function NewOrderPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'orders.write');
  const pool = getPool('app');
  const [clients, sites, zones, types, clock] = await Promise.all([
    listSelectableClients(pool, user),
    listSiteOptions(pool, user),
    listZones(pool, user),
    listSelectableConcreteTypes(pool, user),
    getRequestClock(),
  ]);
  const t = await getTranslations('ledger.orders');
  return (
    <div>
      <PageHeader title={t('title')} />
      <OrderForm
        clients={clients.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          defaultZoneId: c.defaultZoneId,
        }))}
        sites={sites}
        zones={zones.map((z) => ({ id: z.id, name: z.name }))}
        types={types.map((c) => ({ id: c.id, code: c.code, label: c.label }))}
        today={clock.today()}
        createAction={createOrderAction}
        previewAction={can(user.role, 'orders.read_money') ? previewOrderAction : undefined}
      />
    </div>
  );
}
