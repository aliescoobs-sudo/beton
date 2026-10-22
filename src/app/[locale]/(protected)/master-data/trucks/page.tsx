import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listTruckStatusLog, listTrucks } from '@/modules/master-data';
import { TrucksManager } from '@/modules/master-data/ui/trucks/trucks-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';

export default async function TrucksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'trucks.read');
  const trucks = await listTrucks(getPool('app'), user);
  const logs = Object.fromEntries(
    await Promise.all(
      trucks.map(
        async (truck) => [truck.id, await listTruckStatusLog(getPool('app'), user, truck.id)] as const,
      ),
    ),
  );
  const t = await getTranslations('masterData.trucks');
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <TrucksManager
        trucks={trucks}
        logs={logs}
        canEdit={can(user.role, 'trucks.write')}
        canLog={can(user.role, 'trucks.status.write')}
      />
    </main>
  );
}
