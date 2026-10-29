import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getEnv } from '@/lib/server-env';
import { AssistantPanel } from '@/modules/assistant/ui/assistant-panel';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { SecurityAlertBanner } from '@/modules/platform-security/ui/alerts/security-alert-banner';
import { AppShell } from '../../shell/app-shell';
import { buildNav } from '../../shell/nav-model';
import { SimBand } from '../../shell/sim-band';
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
        mainNav: t('shell.nav.main'),
        subNav: t('shell.nav.sub'),
        search: t('shell.searchLabel'),
        searchPlaceholder: t('shell.searchPlaceholder'),
      }}
      homeHref={`/${locale}`}
      searchHref={`/${locale}/search`}
      simBand={<SimBand locale={locale} />}
      // With the flag off there is no entry point at all (AC-ASSIST-01).
      assistant={getEnv().ASSISTANT_ENABLED ? <AssistantPanel role={state.user.role} /> : null}
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
