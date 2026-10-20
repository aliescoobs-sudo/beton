import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listConcreteTypes } from '@/modules/master-data';
import { ConcreteTypesManager } from '@/modules/master-data/ui/concrete-types/concrete-types-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';

export default async function ConcreteTypesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'recettes.read');
  const types = await listConcreteTypes(getPool('app'), user);
  const t = await getTranslations('masterData.concreteTypes');
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ConcreteTypesManager types={types} editable={can(user.role, 'recettes.write')} />
    </main>
  );
}
