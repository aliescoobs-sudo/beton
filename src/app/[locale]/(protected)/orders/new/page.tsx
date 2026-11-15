import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getQuote, listClientAliases, listPoRequiredClientIds } from '@/modules/ledger';
import { OrderForm } from '@/modules/ledger/ui/orders/order-form';
import {
  listGridInForce,
  listSelectableClients,
  listSelectableConcreteTypes,
  listSiteOptions,
  listPlants,
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
  const [clients, sites, zones, types, plants, clock] = await Promise.all([
    listSelectableClients(pool, user),
    listSiteOptions(pool, user),
    listZones(pool, user),
    listSelectableConcreteTypes(pool, user),
    listPlants(pool, user),
    getRequestClock(),
  ]);
  // An order made from a quote starts from it (owner and support read quotes); a person still reviews and saves.
  const grid = await listGridInForce(pool, user, clock.today());
  // T19-close C: which clients require their PO number, and the alternate names the search also matches (a role without the alias door searches by name and code only)
  const poRequired = new Set(await listPoRequiredClientIds(pool, user).catch(() => [] as string[]));
  const aliasesOf = new Map<string, string[]>();
  for (const a of await listClientAliases(pool, user).catch(() => [])) {
    aliasesOf.set(a.clientId, [...(aliasesOf.get(a.clientId) ?? []), a.alias]);
  }
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
          poRequired: poRequired.has(c.id),
          aliases: aliasesOf.get(c.id) ?? [],
        }))}
        sites={sites}
        zones={zones.map((z) => ({ id: z.id, name: z.name }))}
        types={types.map((c) => ({ id: c.id, code: c.code, label: c.label }))}
        plants={
          user.role === 'plant_manager'
            ? []
            : plants.filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name }))
        }
        grid={grid}
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
