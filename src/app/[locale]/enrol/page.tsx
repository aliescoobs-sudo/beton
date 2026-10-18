import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { EnrolFlow } from '@/modules/platform-security/ui/enrol-flow';

export default async function EnrolPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const state = await currentAuthState();
  if (state.kind === 'anonymous') redirect(`/${locale}/login`);
  if (state.kind === 'authenticated') redirect(`/${locale}`);
  const t = await getTranslations('auth.enrol');
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <EnrolFlow locale={locale} />
    </main>
  );
}
