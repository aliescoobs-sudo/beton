import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import {
  getClient,
  listSellingPrices,
  listSelectableConcreteTypes,
  listSites,
  listZones,
} from '@/modules/master-data';
import { ClientDetail } from '@/modules/master-data/ui/clients/client-detail';
import { OverridesPanel } from '@/modules/master-data/ui/selling-prices/overrides-panel';
import { SitesPanel } from '@/modules/master-data/ui/sites/sites-panel';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

export default async function ClientPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'parties.read');
  // Price overrides are money: only the owner and support read them (DECISIONS 81).
  const showOverrides = can(user.role, 'selling_prices.read');
  if (showOverrides) await recordMoneyView(getPool('app'), user, 'screen:client-overrides');
  const [client, zones, sites, types, prices] = await Promise.all([
    getClient(getPool('app'), user, id),
    listZones(getPool('app'), user),
    listSites(getPool('app'), user, id),
    listSelectableConcreteTypes(getPool('app'), user),
    showOverrides ? listSellingPrices(getPool('app'), user, { clientId: id }) : Promise.resolve([]),
  ]);
  if (!client) notFound();
  const typeCode = new Map(types.map((type) => [type.id, type.code]));
  const t = await getTranslations('masterData.clients');
  return (
    <div>
      <Link
        href={`/${locale}/master-data/clients`}
        className="mb-2 inline-block text-sm text-muted underline"
      >
        {t('back')}
      </Link>
      <PageHeader
        title={
          <>
            <bdi dir="ltr" className="num">
              {client.code}
            </bdi>{' '}
            — <bdi>{client.name}</bdi>
          </>
        }
      />
      {client.iceOverrideReason && (
        <p className="mt-2 text-sm text-muted" data-testid="client-override-reason">
          {t('overrideNote', { reason: client.iceOverrideReason })}
        </p>
      )}
      <ClientDetail
        id={client.id}
        initial={{
          name: client.name,
          kind: client.kind,
          ice: client.ice ?? '',
          phone: client.phone ?? '',
          contactName: client.contactName ?? '',
          defaultZoneId: client.defaultZoneId ?? '',
          paymentTermsDays: client.paymentTermsDays,
          notes: client.notes ?? '',
        }}
        archived={client.status === 'archived'}
        zones={zones.map(({ id: zoneId, name }) => ({ id: zoneId, name }))}
        canOverride={can(user.role, 'parties.ice_override')}
        canArchive={can(user.role, 'parties.archive')}
      />
      <SitesPanel
        clientId={client.id}
        sites={sites.map((s) => ({
          id: s.id,
          label: s.label,
          address: s.address ?? '',
          zoneId: s.zoneId ?? '',
        }))}
        zones={zones.map(({ id: zoneId, name }) => ({ id: zoneId, name }))}
      />
      {showOverrides && (
        <OverridesPanel
          clientId={client.id}
          overrides={prices.map((p) => ({
            id: p.id,
            typeCode: typeCode.get(p.concreteTypeId) ?? '—',
            priceHtPerM3Centimes: p.priceHtPerM3Centimes,
            effectiveFrom: p.effectiveFrom,
            reason: p.reason ?? '',
          }))}
          types={types}
          editable={can(user.role, 'client_price_override.write') && client.status === 'active'}
        />
      )}
    </div>
  );
}
