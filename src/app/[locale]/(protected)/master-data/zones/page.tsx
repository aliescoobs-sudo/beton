import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listZones } from '@/modules/master-data';
import { ZonesManager } from '@/modules/master-data/ui/zones/zones-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

export default async function ZonesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'zones.read');
  const zones = await listZones(getPool('app'), user);
  const t = await getTranslations('masterData.zones');
  return (
    <div>
      <PageHeader title={t('title')} />
      <ZonesManager zones={zones} editable={can(user.role, 'zones.write')} />
    </div>
  );
}
