import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listPlants } from '@/modules/master-data';
import { PlantsManager } from '@/modules/master-data/ui/plants/plants-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

export default async function PlantsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'plants.read');
  const plants = await listPlants(getPool('app'), user);
  const t = await getTranslations('masterData.plants');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <PlantsManager plants={plants} editable={can(user.role, 'plants.write')} />
    </div>
  );
}
