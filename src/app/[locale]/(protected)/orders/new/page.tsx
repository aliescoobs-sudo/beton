import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getQuote } from '@/modules/ledger';
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

export default async function NewOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ quote?: string }>;
}) {
  const { locale } = await params;
  const { quote: quoteId } = await searchParams;
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
  // An order made from a quote starts from it (owner and support read quotes); a person still reviews and saves.
  const quote = quoteId && can(user.role, 'quotes.read') ? await getQuote(pool, user, quoteId) : null;
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
        initial={
          quote
            ? {
                clientId: quote.clientId,
                typeId: quote.concreteTypeId,
                volumeM3: String(quote.volumeL / 1000).replace('.', ','),
                quoteId: quote.id,
              }
            : null
        }
        createAction={createOrderAction}
        previewAction={can(user.role, 'orders.read_money') ? previewOrderAction : undefined}
      />
    </div>
  );
}
