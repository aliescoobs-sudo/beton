import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listSuppliers } from '@/modules/master-data';
import { SuppliersManager } from '@/modules/master-data/ui/suppliers/suppliers-manager';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

export default async function SuppliersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'parties.read');
  const suppliers = await listSuppliers(getPool('app'), user);
  const t = await getTranslations('masterData.suppliers');
  return (
    <div>
      <PageHeader title={t('title')} />
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
    </div>
  );
}
