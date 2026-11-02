import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listPlants } from '@/modules/master-data';
import { getAuth } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/auth/page-guard';
import { listUsers } from '@/modules/platform-security/service/user-admin';
import { UsersAdmin } from '@/modules/platform-security/ui/users/users-admin';
import { PageHeader } from '@/ui';

export default async function UsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const owner = await requirePagePermission(locale, 'users.manage');
  const users = await listUsers(
    { auth: getAuth(), authPool: getPool('auth'), appPool: getPool('app') },
    owner,
  );
  const plants = await listPlants(getPool('app'), owner);
  const t = await getTranslations('admin');
  return (
    <div>
      <PageHeader title={t('title')} />
      <UsersAdmin
        users={users}
        selfId={owner.id}
        plants={plants.filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name }))}
        canMakeAdmin={owner.role === 'owner'}
      />
    </div>
  );
}
