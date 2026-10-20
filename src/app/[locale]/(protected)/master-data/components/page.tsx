import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listComponents, listPurchaseUnits } from '@/modules/master-data';
import { ComponentsManager } from '@/modules/master-data/ui/components/components-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';

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
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ComponentsManager components={views} editable={can(user.role, 'components.write')} />
    </main>
  );
}
