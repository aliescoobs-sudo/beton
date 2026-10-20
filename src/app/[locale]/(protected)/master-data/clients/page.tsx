import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listClients, listZones } from '@/modules/master-data';
import { ClientsManager } from '@/modules/master-data/ui/clients/clients-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';

export default async function ClientsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'parties.read');
  const [clients, zones] = await Promise.all([
    listClients(getPool('app'), user),
    listZones(getPool('app'), user),
  ]);
  const t = await getTranslations('masterData.clients');
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ClientsManager
        clients={clients.map(({ id, code, name, kind, status }) => ({ id, code, name, kind, status }))}
        zones={zones.map(({ id, name }) => ({ id, name }))}
        locale={locale}
        canOverride={can(user.role, 'parties.ice_override')}
      />
    </main>
  );
}
