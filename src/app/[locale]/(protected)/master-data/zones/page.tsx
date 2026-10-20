import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listZones } from '@/modules/master-data';
import { ZonesManager } from '@/modules/master-data/ui/zones/zones-manager';
import { can, requirePagePermission } from '@/modules/platform-security';

export default async function ZonesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'zones.read');
  const zones = await listZones(getPool('app'), user);
  const t = await getTranslations('masterData.zones');
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ZonesManager zones={zones} editable={can(user.role, 'zones.write')} />
    </main>
  );
}
