import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { can, type SessionUser, unreadCount } from '@/modules/platform-security';

/** The bell of the top bar: a link to the notification centre with the number of unread alerts. Absent while the module is off. */
export async function NotificationBell({ user, locale }: { user: SessionUser; locale: string }) {
  if (!getEnv().NOTIFICATIONS_ENABLED || !can(user.role, 'notifications.read')) return null;
  const n = await unreadCount(getPool('app'), user);
  const t = await getTranslations('notifications');
  return (
    <Link
      href={`/${locale}/notifications`}
      className="relative inline-flex min-h-11 min-w-11 items-center justify-center text-paper md:min-h-0 md:min-w-0 md:px-2"
      aria-label={t('bell', { count: n })}
      data-testid="notification-bell"
    >
      <span aria-hidden="true">🔔</span>
      {n > 0 && (
        <span
          className="absolute -top-1 end-0 rounded-full bg-signal px-1 text-[10px] font-semibold leading-4"
          data-testid="notification-count"
        >
          {n}
        </span>
      )}
    </Link>
  );
}
