import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { EnrolFlow } from '@/modules/platform-security/ui/enrol-flow';
import { RecoveryCodesPanel } from '@/modules/platform-security/ui/recovery-codes-panel';

// @permission authenticated — a user manages only their own second factor
export default async function SecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');
  const state = await currentAuthState();
  const reenrol = state.kind === 'authenticated' && state.user.reenrolRequired;
  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-2xl font-semibold">{reenrol ? t('enrol.reenrolTitle') : t('security.title')}</h1>
      {reenrol ? <EnrolFlow locale={locale} reenrol /> : <RecoveryCodesPanel />}
    </main>
  );
}
