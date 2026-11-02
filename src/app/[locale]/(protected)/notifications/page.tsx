import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { listMyNotifications } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PushSetup } from '@/modules/platform-security/ui/push-setup';
import { PageHeader } from '@/ui';
import { markAllReadAction, sendTestAction } from './actions';

/** The notification centre: the person's own alerts, newest first, with the switch for push on this phone (R5). */
export default async function NotificationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().NOTIFICATIONS_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'notifications.read');
  const items = await listMyNotifications(getPool('app'), user, 100);
  const t = await getTranslations('notifications');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <div className="mt-4 flex flex-wrap gap-3">
        <form action={markAllReadAction}>
          <button type="submit" className="btn" data-testid="notifications-read-all">
            {t('readAll')}
          </button>
        </form>
        <form action={sendTestAction}>
          <button type="submit" className="btn" data-testid="notifications-test">
            {t('sendTest')}
          </button>
        </form>
      </div>
      <div className="mt-4">
        <PushSetup
          publicKey={getEnv().VAPID_PUBLIC_KEY ?? null}
          workerUrl="/sw.js"
          subscribeUrl="/api/push"
          labels={{
            enable: t('push.enable'),
            enabled: t('push.enabled'),
            unsupported: t('push.unsupported'),
            denied: t('push.denied'),
            unavailable: t('push.unavailable'),
          }}
        />
      </div>
      {items.length === 0 ? (
        <p className="mt-6 text-sm text-muted" data-testid="notifications-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-border" data-testid="notifications-list">
          {items.map((n) => (
            <li key={n.id} className="py-3 text-sm" data-testid={`notification-${n.kind}`} data-read={n.read}>
              <span
                className={
                  n.severity === 'urgent'
                    ? 'font-semibold text-signal'
                    : n.read
                      ? 'text-muted'
                      : 'font-medium'
                }
              >
                {t(`kind.${n.kind}`)}
              </span>
              {Object.entries(n.params).length > 0 && (
                <span className="text-muted">
                  {' '}
                  ·{' '}
                  {Object.values(n.params)
                    .filter((v) => v !== null)
                    .join(' · ')}
                </span>
              )}
              {n.link && (
                <>
                  {' · '}
                  <Link href={`/${locale}${n.link}`} className="underline">
                    {t('open')}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
