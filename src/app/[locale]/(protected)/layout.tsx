import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { SecurityAlertBanner } from '@/modules/platform-security/ui/alerts/security-alert-banner';
import { AppShell } from '../../shell/app-shell';
import { buildNav } from '../../shell/nav-model';
import { SimPill } from '../../shell/sim-pill';
import { UserMenu } from '../../shell/user-menu';

/** Every page in this group needs a fully authenticated (password + 2FA) session. */
export default async function ProtectedLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await currentAuthState();
  if (state.kind === 'anonymous') redirect(`/${locale}/login`);
  if (state.kind === 'needs_enrolment') redirect(`/${locale}/enrol`);
  const t = await getTranslations();
  const groups = buildNav(state.user.role, locale, (key) => t(key as never));
  return (
    <AppShell
      groups={groups}
      labels={{
        brand: t('shell.title'),
        open: t('shell.nav.open'),
        close: t('shell.nav.close'),
        userMenu: t('shell.userMenu'),
        mainNav: t('shell.nav.main'),
      }}
      simPill={<SimPill locale={locale} />}
      userMenu={
        <UserMenu
          name={state.user.name}
          roleLabel={t(`admin.roles.${state.user.role}` as never)}
          menuLabel={t('shell.userMenu')}
          locale={locale}
        />
      }
    >
      <SecurityAlertBanner user={state.user} locale={locale} />
      {children}
    </AppShell>
  );
}
