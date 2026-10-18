import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { LoginFlow } from '@/modules/platform-security/ui/login-flow';

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const state = await currentAuthState();
  if (state.kind === 'authenticated') redirect(`/${locale}`);
  if (state.kind === 'needs_enrolment') redirect(`/${locale}/enrol`);
  const t = await getTranslations('auth.login');
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <LoginFlow locale={locale} />
    </main>
  );
}
