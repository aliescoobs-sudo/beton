import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listComponents, listRecetteVersions, listSelectableConcreteTypes } from '@/modules/master-data';
import { RecettesManager } from '@/modules/master-data/ui/recettes/recettes-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';

export default async function RecettesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'recettes.read');
  const pool = getPool('app');
  const [types, components] = await Promise.all([
    listSelectableConcreteTypes(pool, user),
    listComponents(pool, user),
  ]);
  const views = await Promise.all(
    types.map(async (type) => ({
      id: type.id,
      code: type.code,
      label: type.label,
      versions: await listRecetteVersions(pool, user, type.id),
    })),
  );
  const t = await getTranslations('masterData.recettes');
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <RecettesManager
        types={views}
        components={components
          .filter((c) => c.status === 'active')
          .map((c) => ({ id: c.id, nameFr: c.nameFr, nameAr: c.nameAr, baseUnit: c.baseUnit }))}
        editable={can(user.role, 'recettes.write')}
      />
    </main>
  );
}
