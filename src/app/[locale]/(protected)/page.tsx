import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { homeShortcuts, HomeTilesView, homeTiles } from './home-tiles';
import { buttonClass, PageHeader } from '@/ui';

// @permission authenticated — any user with password + 2FA (guarded by the (protected) layout)
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const state = await currentAuthState();
  const name = state.kind === 'authenticated' ? state.user.name : '';
  const reenrol = state.kind === 'authenticated' && state.user.reenrolRequired;
  const user = state.kind === 'authenticated' ? state.user : null;
  const { tiles, hasData } = user ? await homeTiles(user, locale) : { tiles: [], hasData: false };
  const shortcuts = user
    ? homeShortcuts(user, locale, (key) => t(`shell.home.shortcuts.${key}` as never))
    : [];

  return (
    <div>
      <PageHeader
        title={t('shell.nav.dashboard')}
        description={<span data-testid="signed-in-as">{t('auth.session.signedInAs', { name })}</span>}
      />
      {reenrol && (
        <p
          role="status"
          className="mb-6 border-s-4 border-amber bg-band p-3 text-sm"
          data-testid="reenrol-banner"
        >
          {t('auth.session.reenrolBanner')}{' '}
          <Link href={`/${locale}/security`} className="font-semibold underline">
            {t('auth.session.reenrolLink')}
          </Link>
        </p>
      )}
      {tiles.length > 0 && hasData && (
        <section aria-label={t('shell.home.title')} className="space-y-4">
          <h2 className="text-xl">{t('shell.home.title')}</h2>
          <HomeTilesView tiles={tiles} />
        </section>
      )}
      {shortcuts.length > 0 && (
        <section aria-label={t('shell.home.enter')} className="mt-8" data-testid="home-shortcuts">
          <h2 className="mb-3 text-xl">{t('shell.home.enter')}</h2>
          <div className="flex flex-wrap gap-3">
            {shortcuts.map((s) => (
              <Link key={s.href} href={s.href} className={buttonClass('secondary')}>
                {s.label}
              </Link>
            ))}
          </div>
        </section>
      )}
      {!hasData && (
        <section className="band" data-testid="dashboard-empty">
          <p className="font-display max-w-4xl text-3xl font-bold leading-tight md:text-5xl">
            {t('shell.dashboard.sentence')}
          </p>
          <div className="mt-8">
            <Link href={`/${locale}/master-data/clients`} className={buttonClass('primary')}>
              {t('shell.dashboard.action')}
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
