import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { LogoutButton } from '@/modules/platform-security/ui/logout-button';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const state = await currentAuthState();
  const name = state.kind === 'authenticated' ? state.user.name : '';

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('shell.title')}</h1>
      <p className="mt-2 text-gray-600">{t('shell.tagline')}</p>
      <p className="mt-6" data-testid="signed-in-as">
        {t('auth.session.signedInAs', { name })}
      </p>
      <div className="mt-4">
        <LogoutButton locale={locale} />
      </div>
    </main>
  );
}
