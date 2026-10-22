import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listComponents, listPurchaseUnits } from '@/modules/master-data';
import { ComponentsManager } from '@/modules/master-data/ui/components/components-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

export default async function ComponentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'components.read');
  const [components, units] = await Promise.all([
    listComponents(getPool('app'), user),
    listPurchaseUnits(getPool('app'), user),
  ]);
  const t = await getTranslations('masterData.components');
  const views = components.map((c) => ({
    ...c,
    units: units.filter((u) => u.componentId === c.id),
  }));
  return (
    <div>
      <PageHeader title={t('title')} />
      <ComponentsManager components={views} editable={can(user.role, 'components.write')} />
    </div>
  );
}
