import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { buttonClass, EmptyState, PageHeader } from '@/ui';

// @permission authenticated — any user with password + 2FA (guarded by the (protected) layout)
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const state = await currentAuthState();
  const name = state.kind === 'authenticated' ? state.user.name : '';
  const reenrol = state.kind === 'authenticated' && state.user.reenrolRequired;

  return (
    <div>
      <PageHeader
        title={t('shell.nav.dashboard')}
        description={<span data-testid="signed-in-as">{t('auth.session.signedInAs', { name })}</span>}
      />
      {reenrol && (
        <p
          role="status"
          className="mb-6 rounded-md border border-status-due/60 bg-status-due/10 p-3 text-sm"
          data-testid="reenrol-banner"
        >
          {t('auth.session.reenrolBanner')}{' '}
          <Link href={`/${locale}/security`} className="font-medium underline">
            {t('auth.session.reenrolLink')}
          </Link>
        </p>
      )}
      <EmptyState
        data-testid="dashboard-empty"
        icon={
          <svg
            viewBox="0 0 24 24"
            width="36"
            height="36"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
        }
        title={t('shell.dashboard.emptyTitle')}
        description={t('shell.dashboard.emptyText')}
        action={
          <Link href={`/${locale}/master-data/clients`} className={buttonClass('secondary')}>
            {t('shell.dashboard.action')}
          </Link>
        }
      />
    </div>
  );
}
