import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listSuppliers } from '@/modules/master-data';
import { SuppliersManager } from '@/modules/master-data/ui/suppliers/suppliers-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';

export default async function SuppliersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'parties.read');
  const suppliers = await listSuppliers(getPool('app'), user);
  const t = await getTranslations('masterData.suppliers');
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <SuppliersManager
        suppliers={suppliers.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          category: s.category,
          ice: s.ice ?? '',
          phone: s.phone ?? '',
          paymentTermsDays: s.paymentTermsDays,
          status: s.status,
        }))}
        canArchive={can(user.role, 'parties.archive')}
      />
    </main>
  );
}
