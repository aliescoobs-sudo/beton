import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listApprovals, listPaymentApprovals, listPendingDisclosures } from '@/modules/ledger';
import { DisclosureCards } from '@/modules/ledger/ui/approvals/disclosure-ui';
import { ApprovalsInbox } from '@/modules/ledger/ui/approvals/approvals-inbox';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { decideDisclosureAction } from '../disclosures/actions';
import {
  confirmPriceAction,
  confirmPricesBulkAction,
  decidePaymentApprovalAction,
  releaseHoldAction,
} from './actions';

/** The one inbox of the owner and app_admin: provisional prices to confirm and held orders to release (REQUIREMENTS-V1 §12). */
export default async function ApprovalsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'approvals.read');
  const cards = await listApprovals(getPool('app'), user);
  const disclosures = await listPendingDisclosures(getPool('app'), user);
  // T19-close B (D247): outgoing payments above the upper limit wait for the owner here; the request page stays
  const payments = can(user.role, 'approvals.decide') ? await listPaymentApprovals(getPool('app'), user) : [];
  const t = await getTranslations('ledger.approvals');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {can(user.role, 'approvals.decide') ? (
        <ApprovalsInbox
          cards={cards}
          payments={payments}
          actions={{
            confirmPrice: confirmPriceAction,
            confirmBulk: confirmPricesBulkAction,
            release: releaseHoldAction,
            decidePayment: decidePaymentApprovalAction,
          }}
        />
      ) : (
        <p className="mt-6 text-sm text-muted" data-testid="approvals-readonly">
          {t('readOnly', { count: cards.length })}
        </p>
      )}
      {can(user.role, 'disclosure.decide') && (
        <DisclosureCards cards={disclosures} decide={decideDisclosureAction} />
      )}
    </div>
  );
}
