import { getTranslations } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import type { SessionUser } from '../../auth/session-gate';
import { pendingSecurityAlerts } from '../../service/break-glass';
import { acknowledgeSecurityAlertAction } from './actions';

/** Security alerts (owner 2FA break-glass) for the owner and the partner, until each acknowledges (DECISIONS 75). */
export async function SecurityAlertBanner({ user, locale }: { user: SessionUser; locale: string }) {
  const alerts = await pendingSecurityAlerts(getPool('app'), user);
  if (alerts.length === 0) return null;
  const t = await getTranslations('auth.securityAlert');
  const format = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-MA' : 'fr-MA', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Africa/Casablanca',
  });
  return (
    <div
      className="mb-6 space-y-2 rounded-md border border-status-late/40 bg-status-late/10 px-4 py-3"
      data-testid="security-alerts"
    >
      {alerts.map((alert) => (
        <form
          key={alert.id}
          action={acknowledgeSecurityAlertAction.bind(null, alert.id)}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink"
        >
          <span>{t(alert.kind, { at: format.format(alert.at) })}</span>
          <button type="submit" className="btn btn-danger btn-sm">
            {t('ack')}
          </button>
        </form>
      ))}
    </div>
  );
}
