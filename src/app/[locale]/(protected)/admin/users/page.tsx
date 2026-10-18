import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getAuth } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/auth/page-guard';
import { listUsers } from '@/modules/platform-security/service/user-admin';
import { UsersAdmin } from '@/modules/platform-security/ui/users/users-admin';

export default async function UsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const owner = await requirePagePermission(locale, 'users.manage');
  const users = await listUsers(
    { auth: getAuth(), authPool: getPool('auth'), appPool: getPool('app') },
    owner,
  );
  const t = await getTranslations('admin');
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <UsersAdmin users={users} selfId={owner.id} />
    </main>
  );
}
