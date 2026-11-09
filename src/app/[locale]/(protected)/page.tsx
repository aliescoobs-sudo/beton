import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getEngineParams } from '@/app/engine-params';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { addDaysIso } from '@/modules/ledger';
import { listDeliveryExceptions } from '@/modules/operations';
import { DeliveryExceptions } from '@/modules/operations/ui/delivery-exceptions';
import { OpsToday, OwnerToday } from '@/modules/owner-dashboard';
import { can, recordMoneyView } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { loadDashboard, loadTodayOps } from '@/modules/rules-engine';
import { buttonClass, PageHeader } from '@/ui';
import { confirmExcessAction } from './alerts/actions';
import { homeShortcuts } from './home-tiles';

// @permission authenticated — any user with password + 2FA (guarded by the (protected) layout); the money view is for cash.read
export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ h?: string }>;
}) {
  const { locale } = await params;
  const { h } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations();
  const state = await currentAuthState();
  const name = state.kind === 'authenticated' ? state.user.name : '';
  const reenrol = state.kind === 'authenticated' && state.user.reenrolRequired;
  const user = state.kind === 'authenticated' ? state.user : null;
  const shortcuts = user
    ? homeShortcuts(user, locale, (key) => t(`shell.home.shortcuts.${key}` as never))
    : [];

  const pool = getPool('app');
  const today = (await getRequestClock()).today();
  const horizon = h === '7' ? 7 : h === '14' ? 14 : undefined;
  const params2 = await getEngineParams(horizon);
  let money: Awaited<ReturnType<typeof loadDashboard>> | null = null;
  let ops: Awaited<ReturnType<typeof loadTodayOps>> | null = null;
  if (user && can(user.role, 'cash.read')) {
    await recordMoneyView(pool, user, 'screen:dashboard');
    money = await loadDashboard(pool, user, { today, params: params2 }).catch(() => null);
  } else if (user) {
    ops = await loadTodayOps(pool, user, { today, params: params2 }).catch(() => null);
  }
  // T9b: the delivery exceptions of the last week, for those who track rotations (the plant manager of the plant, the owner): flagged, never corrected
  const exceptions =
    user && can(user.role, 'trips.read')
      ? await listDeliveryExceptions(pool, user, { from: addDaysIso(today, -7), to: today }).catch(() => null)
      : null;
  // The owner's page has nothing to project on a brand-new database (the invitation shows instead); the others always get
  // their "today", empty or not: "nothing to load today" is an answer.
  const hasData = money
    ? money.cash.accounts.length > 0 ||
      money.forecast.some((d) => d.events.length > 0) ||
      money.stock.components.some((c) => c.level !== 0) ||
      money.loads.length > 0
    : ops !== null;

  return (
    <div>
      <PageHeader
        title={t('dashboard.title')}
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
      {hasData && money && (
        <OwnerToday
          view={money}
          locale={locale}
          horizon={params2.horizonDays}
          actions={{ confirmExcess: confirmExcessAction }}
        />
      )}
      {ops && <OpsToday view={ops} locale={locale} />}
      {exceptions?.ok && exceptions.value.length > 0 && (
        <div className="mt-8">
          <DeliveryExceptions items={exceptions.value} />
        </div>
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
