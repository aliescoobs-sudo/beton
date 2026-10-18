import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { LogoutButton } from '@/modules/platform-security/ui/logout-button';

// @permission authenticated — any user with password + 2FA (guarded by the (protected) layout)
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const state = await currentAuthState();
  const name = state.kind === 'authenticated' ? state.user.name : '';
  const reenrol = state.kind === 'authenticated' && state.user.reenrolRequired;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('shell.title')}</h1>
      <p className="mt-2 text-gray-600">{t('shell.tagline')}</p>
      {reenrol && (
        <p
          role="status"
          className="mt-6 rounded border border-amber-400 bg-amber-50 p-3 text-sm"
          data-testid="reenrol-banner"
        >
          {t('auth.session.reenrolBanner')}{' '}
          <Link href={`/${locale}/security`} className="underline">
            {t('auth.session.reenrolLink')}
          </Link>
        </p>
      )}
      <p className="mt-6" data-testid="signed-in-as">
        {t('auth.session.signedInAs', { name })}
      </p>
      <div className="mt-4 flex items-center gap-4">
        <Link href={`/${locale}/security`} className="text-sm underline">
          {t('auth.security.link')}
        </Link>
        <Link href={`/${locale}/historique`} className="text-sm underline" data-testid="history-link">
          {t('history.link')}
        </Link>
        {state.kind === 'authenticated' && (state.user.role === 'owner' || state.user.role === 'partner') && (
          <Link href={`/${locale}/parameters`} className="text-sm underline" data-testid="parameters-link">
            {t('parameters.link')}
          </Link>
        )}
        {state.kind === 'authenticated' && state.user.role === 'owner' && (
          <Link href={`/${locale}/checklist`} className="text-sm underline" data-testid="checklist-link">
            {t('checklist.link')}
          </Link>
        )}
        {state.kind === 'authenticated' && state.user.role === 'owner' && (
          <Link href={`/${locale}/admin/users`} className="text-sm underline" data-testid="admin-link">
            {t('admin.link')}
          </Link>
        )}
        <LogoutButton locale={locale} />
      </div>
    </main>
  );
}
