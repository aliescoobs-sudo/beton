import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { PublicFrame } from '../../shell/public-frame';
import { LoginFlow } from '@/modules/platform-security/ui/login-flow';

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const state = await currentAuthState();
  if (state.kind === 'authenticated') redirect(`/${locale}`);
  if (state.kind === 'needs_enrolment') redirect(`/${locale}/enrol`);
  const t = await getTranslations('auth.login');
  return (
    <PublicFrame locale={locale} title={t('title')}>
      <LoginFlow locale={locale} />
    </PublicFrame>
  );
}
