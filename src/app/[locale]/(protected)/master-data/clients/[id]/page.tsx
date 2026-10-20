import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getClient, listZones } from '@/modules/master-data';
import { ClientDetail } from '@/modules/master-data/ui/clients/client-detail';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';

export default async function ClientPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'parties.read');
  const [client, zones] = await Promise.all([
    getClient(getPool('app'), user, id),
    listZones(getPool('app'), user),
  ]);
  if (!client) notFound();
  const t = await getTranslations('masterData.clients');
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href={`/${locale}/master-data/clients`} className="text-sm underline">
        {t('back')}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">
        <span dir="ltr">{client.code}</span> — {client.name}
      </h1>
      {client.iceOverrideReason && (
        <p className="mt-2 text-sm text-gray-600" data-testid="client-override-reason">
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
    </main>
  );
}
