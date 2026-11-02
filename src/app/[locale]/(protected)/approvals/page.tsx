import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listApprovals } from '@/modules/ledger';
import { ApprovalsInbox } from '@/modules/ledger/ui/approvals/approvals-inbox';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { confirmPriceAction, confirmPricesBulkAction, releaseHoldAction } from './actions';

/** The one inbox of the owner and app_admin: provisional prices to confirm and held orders to release (REQUIREMENTS-V1 §12). */
export default async function ApprovalsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'approvals.read');
  const cards = await listApprovals(getPool('app'), user);
  const t = await getTranslations('ledger.approvals');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {can(user.role, 'approvals.decide') ? (
        <ApprovalsInbox
          cards={cards}
          actions={{
            confirmPrice: confirmPriceAction,
            confirmBulk: confirmPricesBulkAction,
            release: releaseHoldAction,
          }}
        />
      ) : (
        <p className="mt-6 text-sm text-muted" data-testid="approvals-readonly">
          {t('readOnly', { count: cards.length })}
        </p>
      )}
    </div>
  );
}
