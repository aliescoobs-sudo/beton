import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { listFieldAccounts } from '@/modules/field';
import { FieldAdmin } from '@/modules/field/ui/field-admin';
import { getAuth } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { createFieldAccountAction, revokeDeviceAction, setPinAction } from './actions';

export default async function FieldAdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'field.admin');
  const accounts = await listFieldAccounts(
    { appPool: getPool('app'), authPool: getPool('auth'), auth: getAuth(), secret: getEnv().AUTH_SECRET },
    user,
  );
  const t = await getTranslations('field.admin');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <FieldAdmin
        accounts={accounts}
        actions={{ create: createFieldAccountAction, setPin: setPinAction, revoke: revokeDeviceAction }}
      />
    </div>
  );
}
