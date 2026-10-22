import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { EnrolFlow } from '@/modules/platform-security/ui/enrol-flow';
import { RecoveryCodesPanel } from '@/modules/platform-security/ui/recovery-codes-panel';
import { PageHeader } from '@/ui';

// @permission authenticated — a user manages only their own second factor
export default async function SecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');
  const state = await currentAuthState();
  const reenrol = state.kind === 'authenticated' && state.user.reenrolRequired;
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={reenrol ? t('enrol.reenrolTitle') : t('security.title')} />
      {reenrol ? <EnrolFlow locale={locale} reenrol /> : <RecoveryCodesPanel />}
    </div>
  );
}
